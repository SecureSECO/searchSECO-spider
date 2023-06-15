/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import { clone, checkout } from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import * as path from 'path';
const BlameJS = require('blamejs')
const glob = require('glob');
import { exec } from 'child_process';
import Logger, { Verbosity } from './searchSECO-logger/src/Logger'

const SUPPORTED_LANG_EXTENTIONS = [
    'cpp',
    'cs',
    'js',
    'py',
    'java'
]

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
    fileName: string;
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
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                Logger.Warning(`Error executing command: ${cmd} (error): ${error}`, Logger.GetCallerLocation())
                resolve('')
                return
            }

            if (stderr) {
                Logger.Warning(`Error executing command: ${cmd} (stderr): ${stderr}`, Logger.GetCallerLocation())
                resolve('')
                return
            }

            resolve(stdout)
        })
    })
}

export default class Spider {
    private repo: string | null = null;

    constructor(verbosity: Verbosity = Verbosity.DEBUG) {
        Logger.SetModule("spider")
        Logger.SetVerbosity(verbosity)
    }

    /**
     * Clears the directory specified by filePath
     */
    async clearDirectory(filePath: string): Promise<void> {
        try {
            if (!fs.existsSync(filePath))
                return

            await fs.promises.rm(filePath, { recursive: true, force: true })
        } catch (e) {
            Logger.Warning(`Could not remove directory ${filePath}, retrying after 2 seconds...`, Logger.GetCallerLocation())
            setTimeout(async () => {
                await this.clearDirectory(filePath)
            }, 2000)
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
    async downloadRepo(url: string, filePath: string, branch: string): Promise<boolean> {
        try {
            await clone({
                fs,
                http,
                dir: filePath,
                url: url,
                ref: branch,
                singleBranch: false,
            });
            this.repo = filePath;
            return true;
        }
        catch (error) {
            Logger.Warning(`Failed to download ${url} to ${filePath}: ${error}`, Logger.GetCallerLocation())
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
    async updateVersion(prevTag: string, newTag: string, filePath: string, prevUnchangedFiles: string[]): Promise<string[]> {
        // Get list of changed files between prevTag and newTag.
        let changedFiles: string[] = [];
        if (prevTag) {
            const command = `cd "${filePath}" && git diff --name-only ${prevTag} ${newTag}`;
            const changed = await ExecuteCommand(command);
            changedFiles = this.getFilepaths(changed, filePath);
        }
        await this.switchVersion(newTag, filePath);
        Logger.Debug(`Switched to tag: ${newTag}`, Logger.GetCallerLocation())

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
                    await fs.promises.unlink(path.join(filePath, file));
                }
            }
        }

        const unchangedFiles = files.filter(file => !changedFiles.includes(file));

        return unchangedFiles;
    }

    getFilepaths(str: string, filePath: string): string[] {
        const lines = str.split('\n');
        return lines.map(line => path.join(filePath, line));
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
            await checkout({
                fs,
                dir: filePath,
                ref: tag,
            });
        } catch (error) {
            Logger.Warning(`Failed to switch to version ${tag}: ${error}`, Logger.GetCallerLocation())
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
            const files: string[] = await new Promise((resolve, reject) => {
                glob("**/*", { cwd: filePath, nodir: true, ignore: '**/.git/**' }, (err: Error | null, matches: string[]) => {
                    if (err) reject(err);
                    else resolve(matches);
                });
            });

            for (const file of files) {
                const fileString: string = path.normalize(file).replace(filePath, '');
                if (!lines.has(fileString)) {
                    await fs.promises.unlink(path.join(filePath, fileString));
                }
            }
        } catch (error) {
            Logger.Warning(`Failed to trim files in ${filePath}: ${error}`, Logger.GetCallerLocation())
        }
    }


    /**
    * Extracts author data from locally stored project.
    *
    * @param filePath The path into which the project was cloned.
    */
    async downloadAuthor(filePath: string, batchSize = 100): Promise<AuthorData> {
        const authorData: AuthorData = new Map();
        const files = this.getAllFiles(filePath)
            .filter(file => SUPPORTED_LANG_EXTENTIONS.includes(file.split('.').pop()))
            .map(file => file.replace(filePath, '.'));

        while(files.length > 0) {
            const batch = files.splice(0, batchSize)
            const batchAuthorData = await Promise.all(batch.map(file => this.getBlameData(filePath, file)));
            for (let i = 0; i < batch.length; i++) {
                authorData.set(batch[i], batchAuthorData[i])
            }
        }

        return authorData;
    }

    // Ignores .git folder
    getAllFiles(dir: string): string[] {
        function recursivelyGetFiles(currDir: string, acc: string[]): string[] {
            fs.readdirSync(currDir).forEach((file: string) => {
                if (/(^.git)|(\\tests?\\)|(\\dist\\)/.test(file.toLowerCase()))
                    return acc
                const abs_path = path.join(currDir, file);
                try {
                    if (fs.statSync(abs_path).isDirectory()) return recursivelyGetFiles(abs_path, acc);
                    else acc.push(abs_path);
                } catch (e) {
                    return acc
                }
            });
            return acc
        }
    
        return recursivelyGetFiles(dir.replace('\\', '/'), [])
    }

    // Based on https://github.com/mattpardee/git-blame-parser-js
    getBlameData(filePath: string, file: string): Promise<CodeBlock[]> {
        return new Promise((resolve) => {
            // Check the git status before proceeding with blaming
            exec(`git -C ${filePath} status`, (error, stdout, stderr) => {
                if (error) {
                    resolve([]);
                    return;
                }

                if (stderr) {
                    resolve([]);
                    return;
                }
                exec(`git -C ${filePath} blame --line-porcelain "${file}"`, { maxBuffer: Infinity }, (error, stdout, stderr) => {
                    if (error) {
                        resolve([]);
                        return;
                    }

                    if (stderr) {
                        resolve([]);
                        return
                    }

                    const blamejs = new BlameJS();
                    blamejs.parseBlame(stdout);
                    const commitData = blamejs.getCommitData();
                    const lineData: { [key: string]: any }[] = Object.values(blamejs.getLineData());

                    // Group lines by commit hash
                    const groupedLines = lineData.reduce((groups: { [key: string]: any[] }, line) => {
                        (groups[line.hash.toString()] = groups[line.hash.toString()] || []).push(line);
                        return groups;
                    }, {});

                    // Transform into an array of CodeBlock
                    const codeBlocks: CodeBlock[] = [];
                    for (const hash in groupedLines) {
                        const commit = commitData[hash];
                        const lines = groupedLines[hash];
                        codeBlocks.push({
                            line: lines[0].originalLine,
                            numLines: lines.length,
                            commit: {
                                author: commit.author,
                                authorMail: commit.authorMail,
                                authorTime: commit.authorTime,
                                authorTz: commit.authorTz,
                                committer: commit.committer,
                                committerMail: commit.committerMail,
                                committerTime: commit.committerTime,
                                committerTz: commit.committerTz,
                                summary: commit.summary,
                                previousHash: commit.previousHash,
                                fileName: commit.filename,
                            },
                        });
                    }
                    resolve(codeBlocks);
                });
            });
        });
    }


    async getTags(filePath: string): Promise<[string, number, string][]> {
        const tagsStr = await ExecuteCommand(`git -C ${filePath} tag`)
        const tags: [string, number, string][] = []
        tagsStr.split('\n').forEach(async tag => {
            if (!tag)
                return
            const timeStampStr = await ExecuteCommand(`git -C ${filePath} show -1 -s --format=%ct ${tag}`)
            if (timeStampStr) {
                const timeStamp = parseInt(timeStampStr) * 1000
                const commitHash = await this.getCommitHash(filePath, tag)
                tags.push([tag, timeStamp, commitHash])
            }
        })

        tags.sort((a: [string, number, string], b: [string, number, string]) => {
            if (a[1] < b[1])
                return -1
            else if (a[1] == b[1])
                return 0
            return 1
        })

        return tags
    }

    getCommitHash(filePath: string, tag: string): Promise<string> {
        return new Promise((resolve) => {
            exec(`git -C ${filePath} rev-list -n 1 ${tag}`, (error, stdout, stderr) => {
                if (error) {
                    resolve('')
                    return
                }

                if (stderr) {
                    resolve('')
                    return
                }

                resolve(stdout.substring(0, stdout.length - 1))
            })
        })
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

        let currParent = "";
        let currMessage = "";
        let currFile = "";
        let currLines = new Map<string, number[]>();
        const lines = vulnsStr.split('\n');

        for (const line of lines) {
            if (line.startsWith('START')) {
                if (currMessage !== "" && !/(merge|revert|upgrade)/i.test(currMessage)) {
                    const codePos = currMessage.indexOf("CVE-");
                    vulns.push({
                        commit: currParent,
                        vulnerability: currMessage.slice(codePos, currMessage.indexOf(" ", codePos)),
                        lines: currLines
                    });
                }
                currMessage = "";
                currLines = new Map<string, number[]>();
            } else if (line.startsWith('Parent: ')) {
                currParent = line.slice(8, line.indexOf(' ', 8));
            } else if (line.startsWith('Title: ') || line.startsWith('Message: ')) {
                currMessage += line.slice(line.indexOf(' ')) + "\n";
            } else if (line.startsWith('diff')) {
                currFile = line.slice(11, line.indexOf(' ', 11));
                currLines.set(currFile, []);
            } else if (line.startsWith('@@')) {
                const lineNumStr = line.slice(4, line.indexOf(' ', 4));
                const lineNumArr = lineNumStr.split(',').map(x => parseInt(x));
                if (lineNumArr.length === 2) {
                    for (let i = 0; i < lineNumArr[1]; i++) {
                        currLines.get(currFile)?.push(lineNumArr[0] + i);
                    }
                } else {
                    currLines.get(currFile)?.push(lineNumArr[0]);
                }
            } else if (line) {
                currMessage += line + "\n";
            }
        }

        if (currMessage !== "" && !/(merge|revert|upgrade)/i.test(currMessage)) {
            const codePos = currMessage.indexOf("CVE-");
            vulns.push({
                commit: currParent,
                vulnerability: currMessage.slice(codePos, currMessage.indexOf(" ", codePos)),
                lines: currLines
            });
        }

        return vulns;
    }

    async getVersionTime(filePath: string, version: string): Promise<string> {
        return new Promise((resolve) => {
            exec(`git -C ${filePath} show -s --format=%ct ${version}`, (error, stdout, stderr) => {
                if (error) {
                    resolve('')
                    return
                }
                if (stderr) {
                    resolve('')
                    return
                }

                resolve(`${stdout.substring(0, stdout.indexOf('\n'))}000`)
            })
        })
    }


}
