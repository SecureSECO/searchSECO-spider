import git, { clone, checkout } from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import * as path from 'path';
const BlameJS = require('blamejs')
const glob = require('glob');
import { exec } from 'child_process';

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
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error)
                return
            }

            if (stderr) {
                reject(new Error(stderr))
                return
            }

            resolve(stdout)
        })
    })
}

export default class Spider {
    private repo: string | null = null;

    /**
     * Clears the directory specified by filePath
     */
    async clearDirectory(filePath: string): Promise<void> {
        return new Promise(resolve => {

            if (!fs.existsSync(filePath))
                resolve()

            fs.promises.readdir(filePath).then(files => {
                files.forEach(async file => {
                    await fs.promises.rm(path.join(filePath, file), { recursive: true, force: true })
                })
                resolve()
            })
        })
    }

    /**
    * Downloads a repository from a given source and stores it
    * locally at the location defined by filePath.
    *
    * @param url Url to source to download.
    * @param filePath Local path where to store the source.
    * @param branch Branch of the source to download.
    */
    async downloadRepo(url: string, filePath: string, branch: string): Promise<void> {
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
        }
        catch (error) {
            console.error(`Failed to download ${url} to ${filePath}: ${error}`);
            throw error;
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
        console.log(`Switched to tag: ${newTag}`);

        // Get all files in repository.
        const files = await this.getAllFiles(filePath);

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
            console.error(`Failed to switch to version ${tag}: ${error}`);
            throw error;
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
            console.error(`Failed to trim files in ${filePath}: ${error}`);
        }
    }


    /**
    * Extracts author data from locally stored project.
    *
    * @param filePath The path into which the project was cloned.
    * @param lines The files to keep.
    */
    async downloadAuthor(filePath: string): Promise<AuthorData> {
        const authorData: AuthorData = new Map();
        const files = await this.getAllFiles(filePath);

        // Each file is processed in parallel
        const allAuthorData = await Promise.all(files.map(file => this.getBlameData(filePath, file)));

        // Set the authorData map
        for (let i = 0; i < files.length; i++) {
            authorData.set(files[i], allAuthorData[i]);
        }

        return authorData;
    }

    // Ignores .git folder
    async getAllFiles(filePath: string): Promise<string[]> {
        const allFiles = await fs.promises.readdir(filePath, { withFileTypes: true });
        const fileNames = allFiles
            .filter(dirent => dirent.isFile() && !/^.git/.test(dirent.name))
            .map(dirent => dirent.name);

        return fileNames;
    }

    // Based on https://github.com/mattpardee/git-blame-parser-js
    getBlameData(filePath: string, file: string): Promise<CodeBlock[]> {
        return new Promise((resolve, reject) => {
            // Check the git status before proceeding with blaming
            exec(`git -C ${filePath} status`, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                if (stderr) {
                    reject(new Error(stderr));
                    return;
                }
                exec(`git -C ${filePath} blame --line-porcelain "${file}"`, { maxBuffer: Infinity }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    if (stderr) {
                        reject(new Error(stderr));
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
                            line: lines[0].lineNumber,
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
        return new Promise((resolve, reject) => {
            exec(`git -C ${filePath} rev-list -n 1 ${tag}`, (error, stdout, stderr) => {
                if (error) {
                    reject(error)
                    return
                }

                if (stderr) {
                    reject(new Error(stderr))
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
            } else {
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
        return new Promise((resolve, reject) => {
            exec(`git -C ${filePath} show -s --format=%ct ${version}`, (error, stdout, stderr) => {
                if (error) {
                    reject(error)
                    return
                }
                if (stderr) {
                    reject(new Error(stderr))
                    return
                }

                resolve(`${stdout.substring(0, stdout.indexOf('\n'))}000`)
            })
        })
    }


}
