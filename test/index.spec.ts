import { faker } from '@faker-js/faker';
import { Octokit } from '@octokit/rest';
import RepoSyncService from '../src';

const mocks = {
  repos: {
    getCommit: jest.fn(),
    createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
    getContent: jest.fn().mockResolvedValue({
      data: { sha: faker.git.commitSha() },
    }),
    deleteFile: jest.fn().mockResolvedValue({}),
  },
  git: {
    getRef: jest.fn().mockResolvedValue({
      data: {
        object: {
          sha: faker.git.commitSha(),
        },
      },
    }),
    createRef: jest.fn().mockResolvedValue({}),
    getBlob: jest.fn().mockImplementation(({ file_sha }) => {
      return Promise.resolve({
        data: { content: faker.string.alphanumeric(100) },
      });
    }),
  },
  pulls: {
    create: jest.fn().mockResolvedValue({
      data: {
        html_url: faker.internet.url(),
        number: faker.number.int(),
      },
    }),
    requestReviewers: jest.fn().mockResolvedValue({}),
  },
};

jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn(() => ({
      ...mocks,
    })),
  };
});

// Utility function to generate a fake GitHubCommitInfo object
function generateFakeGitHubCommitInfo({ override = {} }) {
  return {
    author: {
      email: faker.internet.email(),
      name: faker.person.fullName(),
      username: faker.internet.userName(),
    },
    committer: {
      email: faker.internet.email(),
      name: faker.person.fullName(),
      username: faker.internet.userName(),
    },
    distinct: faker.datatype.boolean(),
    id: faker.git.commitSha(),
    message: faker.lorem.lines(),
    timestamp: faker.date.past().toISOString(),
    tree_id: faker.git.commitSha(),
    url: faker.internet.url(),
    ...override,
  };
}

// Utility function to generate RepositoryConfig objects
function generateFakeRepositoryConfig() {
  return {
    owner: faker.internet.userName(),
    repo: faker.system.commonFileName(),
    path: faker.system.filePath(),
    branch: `branch-${faker.lorem.word()}`,
  };
}

// Generate fake configuration
function generateFakeConfig() {
  return {
    repositories: Array.from({ length: 2 }, generateFakeRepositoryConfig),
    syncBranchPrefix: faker.lorem.word(),
    accessToken: faker.string.alphanumeric(30),
  };
}

describe('RepoSyncService', () => {
  const exampleConfig = generateFakeConfig();

  describe('constructor', () => {
    it('should create an instance with the given configuration', () => {
      const repoSyncService = new RepoSyncService(exampleConfig);
      expect(repoSyncService).toBeDefined();
      // Check if the config is set correctly
      expect(repoSyncService.getConfig()).toEqual(exampleConfig);
      // Check if octokit has been initialized with the accessToken
      expect(Octokit).toHaveBeenCalledWith({ auth: exampleConfig.accessToken });
    });
  });

  describe('execute', () => {
    let repoSyncService: RepoSyncService;
    const exampleConfig = generateFakeConfig();

    beforeEach(() => {
      repoSyncService = new RepoSyncService(exampleConfig);
      // Reset all mocks
      jest.clearAllMocks();
    });

    it('should synchronize commits successfully', async () => {
      // Ensure our source repository is part of the exampleConfig
      const sourceRepositoryIndex = faker.datatype.number({
        min: 0,
        max: exampleConfig.repositories.length - 1,
      });
      const sourceRepositoryConfig =
        exampleConfig.repositories[sourceRepositoryIndex];
      const sourceRepository = `${sourceRepositoryConfig.owner}/${sourceRepositoryConfig.repo}`;
      const commitsData = new Array(5).fill(0).map((_, index) => ({
        data: generateFakeGitHubCommitInfo({
          override: {
            // Make the first 4 commits distinct, and the rest non-distinct
            distinct: index <= 3,
          },
        }),
        status: ['added', 'modified', 'removed', 'renamed'][index % 4],
      }));
      const commits = commitsData.map(commit => commit.data);
      const distinctCommits = commits.filter(commit => commit.distinct);

      mocks.repos.getCommit.mockImplementation(({ ref }) => {
        const commit = commits.find(commit => commit.id === ref);
        if (commit) {
          const status = commitsData.find(
            commitData => commitData.data.id === commit.id
          )?.status;
          return Promise.resolve({
            data: {
              files: [
                {
                  filename: `${
                    exampleConfig.repositories[sourceRepositoryIndex].path
                  }${faker.system.fileName()}`,
                  sha: commit.tree_id,
                  status: status,
                  previous_filename:
                    status === 'renamed' ? 'old_file_name' : '',
                },
              ],
            },
          });
        } else {
          return Promise.resolve({ data: {} });
        }
      });

      await repoSyncService.execute(sourceRepository, commits);

      const targetRepositoryConfigs = exampleConfig.repositories.filter(
        (_, index) => index !== sourceRepositoryIndex
      );
      const targetRepositoryCount = targetRepositoryConfigs.length;

      expect(mocks.git.createRef).toHaveBeenCalledTimes(
        1 * targetRepositoryCount
      );
      for (let index = 0; index < targetRepositoryCount; index++) {
        expect(mocks.git.createRef).toHaveBeenCalledWith({
          owner: targetRepositoryConfigs[index].owner,
          repo: targetRepositoryConfigs[index].repo,
          ref: expect.stringMatching(
            new RegExp(`^refs/heads/${exampleConfig.syncBranchPrefix}-\\d+$`)
          ),
          sha: (
            (await mocks.git.getRef.mock.results[index].value) as {
              data: { object: { sha: string } };
            }
          ).data.object.sha,
        });
      }

      expect(mocks.repos.getCommit).toHaveBeenCalledTimes(
        distinctCommits.length * targetRepositoryCount
      );
      distinctCommits.forEach(commit => {
        expect(mocks.repos.getCommit).toHaveBeenCalledWith({
          owner: exampleConfig.repositories[sourceRepositoryIndex].owner,
          repo: exampleConfig.repositories[sourceRepositoryIndex].repo,
          ref: commit.id,
        });
      });

      expect(mocks.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(
        commitsData.filter(
          commit => commit.data.distinct && commit.status !== 'removed'
        ).length * targetRepositoryCount
      );

      expect(mocks.repos.deleteFile).toHaveBeenCalledTimes(
        commitsData.filter(
          commit =>
            commit.data.distinct &&
            ['removed', 'renamed'].includes(commit.status)
        ).length * targetRepositoryCount
      );

      expect(mocks.pulls.create).toHaveBeenCalledTimes(
        1 * targetRepositoryCount
      );
      for (let index = 0; index < targetRepositoryCount; index++) {
        expect(mocks.pulls.create).toHaveBeenCalledWith({
          owner: targetRepositoryConfigs[index].owner,
          repo: targetRepositoryConfigs[index].repo,
          head: expect.stringMatching(
            new RegExp(`^${exampleConfig.syncBranchPrefix}-\\d+$`)
          ),
          base: targetRepositoryConfigs[index].branch,
          title: `Sync models directory with ${sourceRepository}`,
          body: expect.any(String),
        });
      }

      expect(mocks.pulls.requestReviewers).toHaveBeenCalledTimes(
        1 * targetRepositoryCount
      );
      for (let index = 0; index < targetRepositoryCount; index++) {
        expect(mocks.pulls.requestReviewers).toHaveBeenCalledWith({
          owner: targetRepositoryConfigs[index].owner,
          repo: targetRepositoryConfigs[index].repo,
          pull_number: (
            (await mocks.pulls.create.mock.results[index].value) as {
              data: {
                html_url: string;
                number: number;
              };
            }
          ).data.number,
          reviewers: [targetRepositoryConfigs[index].owner],
        });
      }
    });

    it('should throw an error for invalid source repository format', async () => {
      const invalidSourceRepository = 'invalidformat';
      const commits = [generateFakeGitHubCommitInfo({})];
      await expect(
        repoSyncService.execute(invalidSourceRepository, commits)
      ).rejects.toThrow(
        "The source repository must be in the format 'owner/repo'"
      );
    });

    it('should throw an error if the source repository is not configured for sync', async () => {
      const nonConfiguredRepo = 'nonexistent/owner-repo';
      const commits = [generateFakeGitHubCommitInfo({})];
      await expect(
        repoSyncService.execute(nonConfiguredRepo, commits)
      ).rejects.toThrow(
        'Source repository nonexistent/owner-repo is not in the list of repositories to sync'
      );
    });
  });
});
