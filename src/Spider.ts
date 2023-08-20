import fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import Logger, { Verbosity } from './searchSECO-logger/src/Logger';

const EXCLUDE_PATTERNS = [
	'.git',
	'test',
	'tests',
	'build',
	'dist',
	'demo',
	'docs',
	'node_modules',
	'generated',
	'backup',
	'examples',
    '.min.',
    '-min.'
];

const TAGS_COUNT = 20;

export interface CommitData {
	author: string;
	authorMail: string;
	authorTime: string;
	authorTz: string;
	committer: string;
	committerMail: string;
	committerTime: string;
	committerTz: string;
	summary: string;
	previousHash: string;
	filename: string;
}

type CommitOutput = {
	[key: string]: CommitData
}

type LineData = {
	code: string,
	finalLine: string,
	hash: string,
	numLines: string,
	originalLine: string
}

export interface CodeBlock {
	line: number;
	numLines: number;
	commit: CommitData;
}

export type AuthorData = Map<string, CodeBlock[]>;

export interface VulnerabilityData {
	commit: string;
	vulnerability: string;
	lines: Map<string, number[]>;
}


async function ExecuteCommand(cmd: string): Promise<string> {
	return new Promise((resolve) => {
		exec(cmd, { maxBuffer: Infinity }, (error, stdout, stderr) => {
			if (error && !stdout) {
				Logger.Error(`Error executing command: ${cmd} (error): ${error}`, Logger.GetCallerLocation());
				resolve('');
				return;
			}

			if (stderr && !stdout) {
				resolve('');
				return;
			}

			resolve(stdout);
		});
	});
}

function join(str: string[], combinator: string, start: number = 0): string {
    const copy = str.slice(start)
    return copy.join(combinator)
}

class GitBlamer {
    public ParseBlame(input: string): CodeBlock[] {
        const lines = input.split('\n')
        const commitData = new Map<string, CommitData>()
        const codeData: CodeBlock[] = []

        let codeBlocks = -1
        let settingCommitData = false

        let currentCommitHash = ''
        let previousCommitHash = ''

        for (let i = 0; i < lines.length; i++) {
            if (lines[i][0] === '\t') {
                settingCommitData = false
                previousCommitHash = currentCommitHash
                continue
            }

            const arrLine = lines[i].split(' ')
            if (settingCommitData) {
                this.parseCommitLine(currentCommitHash, commitData, arrLine)
                continue
            }

            if (arrLine[0] === "previous")
                continue

			const isHash = /([a-f0-9]{40})/.test(arrLine[0])
			if (!isHash)
				continue

            currentCommitHash = arrLine[0]
            if (currentCommitHash !== previousCommitHash) {
                if (!commitData.has(currentCommitHash)) {
                    settingCommitData = true
                    commitData.set(currentCommitHash, {} as CommitData)
                }

                codeBlocks++
                codeData.push({
                    line: Number(arrLine[2]),
                    numLines: 1,
                    commit: commitData.get(currentCommitHash)
                })
            } 
            else codeData[codeBlocks].numLines++
        }
        return codeData
    }

    private parseCommitLine(commit: string, commitData: Map<string, CommitData>, line: string[]) {
        if (line.length < 2) {
            if (line[0] === "boundary")
                return
            // Set author to unknown if author's name isn't given.
            if (line[0] === "author")
            {
                commitData.get(commit).author = "Unknown author";
                return;
            }
            // Set committer to unknown if committer's's name isn't given.
            if (line[0] === "committer")
            {
                commitData.get(commit).committer = "Unknown committer";
                return;
            }
            Logger.Warning("Blame data has incorrect format.", Logger.GetCallerLocation());
            return;
        }

        switch (line[0]) {
            case 'author': commitData.get(commit).author = join(line, ' ', 1); break;
            case "author-mail": commitData.get(commit).authorMail = line[1]; break;
            case "author-time": commitData.get(commit).authorTime = line[1]; break;
            case "author-tz": commitData.get(commit).authorTz = line[1]; break;
            case "committer": commitData.get(commit).committer = join(line, ' ', 1); break;
            case "committer-mail": commitData.get(commit).committerMail = line[1]; break;
            case "committer-time": commitData.get(commit).committerTime = line[1]; break;
            case "committer-tz": commitData.get(commit).committerTz = line[1]; break;
            case "summary": commitData.get(commit).summary = join(line, ' ', 1); break;
            case "filename": commitData.get(commit).filename = line[1]; break;
            case "previous": commitData.get(commit).previousHash = join(line, ' ', 1); break;
        }
    }

}

export default class Spider {
	private repo: string | null = null;

	constructor(verbosity: Verbosity = Verbosity.DEBUG) {
		Logger.SetModule('spider');
		Logger.SetVerbosity(verbosity);
	}

	/**
	 * Clears a directory
	 * @param filePath The filePath to clear
	 */
	async clearDirectory(filePath: string): Promise<void> {
		try {
			if (!fs.existsSync(filePath)) return;

			await fs.promises.rm(filePath, { recursive: true, force: true });
		} catch (e) {
			Logger.Warning(`Could not remove directory ${filePath}, retrying after 2 seconds...`, Logger.GetCallerLocation());
			setTimeout(async () => {
				await this.clearDirectory(filePath);
			}, 2000);
		}
	}

	/**
	 * Downloads a repository from a given source and stores it
	 * locally at the location defined by filePath.
	 *
	 * @param url Url to source to download.
	 * @param filePath Local path where to store the source.
	 * @param branch Branch of the source to download.
	 */
	async downloadRepo(url: string, filePath: string, branch: string = undefined): Promise<boolean> {
		try {
			await ExecuteCommand(`git clone ${url} ${branch ? `--branch ${branch}` : ''} --single-branch ${filePath}`);

			// await clone({
			//     fs,
			//     http,
			//     dir: filePath,
			//     url: url,
			//     ref: branch,
			//     singleBranch: false,
			// });
			this.repo = filePath;
			return true;
		} catch (error) {
			Logger.Warning(`Failed to download ${url} to ${filePath}: ${error}`, Logger.GetCallerLocation());
			return false;
		}
	}

	/**
	 * Updates project from one version to another, keeping track of unchanged files.
	 * Deletes unchanged files from local project.
	 *
	 * @param prevTag Name of current version.
	 * @param newTag Name of version to update to.
	 * @param filePath Local path where the project is stored.
	 * @param prevUnchangedFiles Name of the previous unchanged files,
	 *                           which were deleted from the local project.
	 */
	async updateVersion(
		prevTag: string,
		newTag: string,
		filePath: string,
		prevUnchangedFiles: string[]
	): Promise<string[]> {
		await ExecuteCommand(`git -C ${filePath} reset --hard`);

		// Get list of changed files between prevTag and newTag.
		let changedFiles: string[] = [];
		if (prevTag) {
			const command = `cd "${filePath}" && git diff --name-only ${prevTag} ${newTag}`;
			const changed = await ExecuteCommand(command);
			changedFiles = changed
				.split('\n')
				.map((file) => path.join(filePath, file))
				.filter((file) => !EXCLUDE_PATTERNS.some((pat) => file.includes(pat)));
		}
		await this.switchVersion(newTag, filePath);
		Logger.Debug(`Switched to tag: ${newTag}`, Logger.GetCallerLocation());

		// Get all files in repository.
		const files = this.getAllFiles(filePath);

		// Delete all unchanged files.
		const removedFiles: string[] = [];
		if (prevTag) {
			for (const file of prevUnchangedFiles) {
				if (!changedFiles.includes(file)) {
					removedFiles.push(file);
				}
			}
			for (const file of files) {
				if (!changedFiles.includes(file)) {
					const fileString = path.relative(filePath, file).replace(/\\/g, '/');
					removedFiles.push(fileString);

					// Delete file locally.
					await fs.promises.unlink(file);
				}
			}
		}

		const unchangedFiles = files
			.filter((file) => !changedFiles.includes(file))
			.map((file) => file.replace(filePath, '.'));
		return unchangedFiles;
	}

	/**
	 * Switches local project to different version.
	 *
	 * @param tag Name of the version to update to.
	 * @param filePath Local path where project is stored.
	 */
	async switchVersion(tag: string, filePath: string): Promise<void> {
		try {
			if (!fs.existsSync(filePath)) {
				throw new Error('Repository not found.');
			}
			await ExecuteCommand(`git -C ${filePath} reset --hard`);
			await ExecuteCommand(`git -C ${filePath} stash`);
			await ExecuteCommand(`git -C ${filePath} checkout ${tag}`);
		} catch (error) {
			Logger.Warning(`Failed to switch to version ${tag}: ${error}`, Logger.GetCallerLocation());
		}
	}

	/**
	 * Trims the local files to only keep the specified ones.
	 *
	 * @param filePath The path into which the project was cloned.
	 * @param lines The files to keep.
	 */
	async trimFiles(filePath: string, lines: Map<string, number[]>): Promise<void> {
		try {
			// const files: string[] = await new Promise((resolve, reject) => {
			//     glob("**/*", { cwd: filePath, nodir: true, ignore: '**/.git/**' }, (err: Error | null, matches: string[]) => {
			//         if (err) reject(err);
			//         else resolve(matches);
			//     });
			// });

			const files = this.getAllFiles(filePath).map((file) => file.replace(filePath, ''));

			for (const file of files) {
				const fileString: string = path.normalize(file).replace(filePath, '');
				if (!lines.has(fileString)) {
					await fs.promises.unlink(path.join(filePath, fileString));
				}
			}
		} catch (error) {
			Logger.Warning(`Failed to trim files in ${filePath}: ${error}`, Logger.GetCallerLocation());
		}
	}

	/**
	 * Extracts author data from locally stored project.
	 *
	 * @param filePath The path into which the project was cloned.
	 */
	async downloadAuthor(filePath: string, files: string[], batchSize = 25): Promise<AuthorData> {
		Logger.Info(`Blaming and processing ${files.length} files`, Logger.GetCallerLocation());

		const authorData: AuthorData = new Map();

		while (files.length > 0) {
			const batch = files.splice(0, batchSize);
			Logger.Debug(`${files.length} files left`, Logger.GetCallerLocation());
			const batchAuthorData = await Promise.all(batch.map((file) => this.getBlameData(filePath, file)));
			for (let i = 0; i < batch.length; i++) {
				authorData.set(batch[i], batchAuthorData[i]);
			}
		}

		return authorData;
	}

	// Ignores .git folder
	getAllFiles(dir: string): string[] {
		function recursivelyGetFiles(currDir: string, acc: string[]): string[] {
			fs.readdirSync(currDir).forEach((file: string) => {
				if (EXCLUDE_PATTERNS.some((pat) => file.toLowerCase().includes(pat))) return acc;
				const abs_path = path.join(currDir, file);
				try {
					if (fs.statSync(abs_path).isDirectory()) return recursivelyGetFiles(abs_path, acc);
					else acc.push(abs_path);
				} catch (e) {
					return acc;
				}
			});
			return acc;
		}

		return recursivelyGetFiles(dir, []);
	}

	// Based on https://github.com/mattpardee/git-blame-parser-js
	async getBlameData(filePath: string, file: string): Promise<CodeBlock[]> {
		await ExecuteCommand(`git -C ${filePath} status`)
		const stdout = await ExecuteCommand(`git -C ${filePath} blame --line-porcelain "${file}"`)

		const gitblamer = new GitBlamer()
		const codeBlocks2 = gitblamer.ParseBlame(stdout)

		return codeBlocks2
	}

	async getTags(filePath: string): Promise<[string, number, string][]> {
		const tagsStr = await ExecuteCommand(`git -C ${filePath} tag`);
		const processedTags: [string, number, string][] = [];

		let tags = tagsStr.split('\n').filter((tag) => tag);
		Logger.Info(`Project has ${tags.length} tags`, Logger.GetCallerLocation());

		// Select a subset of the tags if the count is too high
		if (tags.length > TAGS_COUNT) {
			Logger.Info(`Grabbing a subset of ${TAGS_COUNT} tags`, Logger.GetCallerLocation());
			const newTags: string[] = [];
			const fraction = (tags.length - 1) / (TAGS_COUNT - 1);
			for (let i = 0; i < TAGS_COUNT; i++) newTags[i] = tags[Math.round(fraction * i)];
			tags = JSON.parse(JSON.stringify(newTags));
		}

		for (const tag of tags) {
			const timeStampStr = await ExecuteCommand(`git -C ${filePath} show -1 -s --format=%ct ${tag}`);
			if (timeStampStr) {
				const timeStamp = parseInt(timeStampStr) * 1000;
				const commitHash = await this.getCommitHash(filePath, tag);
				if (commitHash) processedTags.push([tag, timeStamp, commitHash]);
			}
		}

		processedTags.sort((a: [string, number, string], b: [string, number, string]) => {
			if (a[1] < b[1]) return -1;
			else if (a[1] == b[1]) return 0;
			return 1;
		});
		return processedTags;
	}

	async getCommitHash(filePath: string, tag: string): Promise<string> {
		const result = await ExecuteCommand(`git -C ${filePath} rev-list -n 1 ${tag}`);
		if (!result) return '';
		return result.substring(0, result.length - 1);
	}

	/**
	 * Extracts vulnerability data from locally stored project.
	 *
	 * @param filePath The path into which the project was cloned.
	 */
	async getVulns(filePath: string): Promise<VulnerabilityData[]> {
		const command = `git -C "${filePath}" --no-pager log --all -p --unified=0 --no-prefix --pretty=format:"START%nParent: %P%nTitle: %s%nMessage: %b%nEND%n" --grep="CVE-20"`;
		const vulnsStr = await ExecuteCommand(command);

		const vulns: VulnerabilityData[] = [];

		let currParent = '';
		let currMessage = '';
		let currFile = '';
		let currLines = new Map<string, number[]>();
		const lines = vulnsStr.split('\n');

		for (const line of lines) {
			if (line.startsWith('START')) {
				if (currMessage !== '' && !/(merge|revert|upgrade)/i.test(currMessage)) {
					const codePos = currMessage.indexOf('CVE-');
					vulns.push({
						commit: currParent,
						vulnerability: currMessage.slice(codePos, currMessage.indexOf(' ', codePos)),
						lines: currLines,
					});
				}
				currMessage = '';
				currLines = new Map<string, number[]>();
			} else if (line.startsWith('Parent: ')) {
				currParent = line.slice(8, line.indexOf(' ', 8));
			} else if (line.startsWith('Title: ') || line.startsWith('Message: ')) {
				currMessage += line.slice(line.indexOf(' ')) + '\n';
			} else if (line.startsWith('diff')) {
				currFile = line.slice(11, line.indexOf(' ', 11));
				currLines.set(currFile, []);
			} else if (line.startsWith('@@')) {
				const lineNumStr = line.slice(4, line.indexOf(' ', 4));
				const lineNumArr = lineNumStr.split(',').map((x) => parseInt(x));
				if (lineNumArr.length === 2) {
					for (let i = 0; i < lineNumArr[1]; i++) {
						currLines.get(currFile)?.push(lineNumArr[0] + i);
					}
				} else {
					currLines.get(currFile)?.push(lineNumArr[0]);
				}
			} else if (line) {
				currMessage += line + '\n';
			}
		}

		if (currMessage !== '' && !/(merge|revert|upgrade)/i.test(currMessage)) {
			const codePos = currMessage.indexOf('CVE-');
			vulns.push({
				commit: currParent,
				vulnerability: currMessage.slice(codePos, currMessage.indexOf(' ', codePos)),
				lines: currLines,
			});
		}

		return vulns;
	}

	async getVersionTime(filePath: string, version: string): Promise<string> {
		return new Promise((resolve) => {
			exec(`git -C ${filePath} show -s --format=%ct ${version}`, (error, stdout, stderr) => {
				if (error) {
					resolve('');
					return;
				}
				if (stderr) {
					resolve('');
					return;
				}

				resolve(`${stdout.substring(0, stdout.indexOf('\n'))}000`);
			});
		});
	}
}
