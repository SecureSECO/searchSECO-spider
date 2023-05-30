import Spider from "../src/Spider";
import fs from "fs";
import path from "path";
import git from 'isomorphic-git';

const tempDir = path.join(__dirname, "../.tmp")

describe("Spider", () => {
    let spider: Spider;

    beforeAll(() => {
        spider = new Spider();
    });

    afterAll(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    })

    describe("downloadRepo", () => {
        it("downloads repo and checks out specified branch", async () => {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }

            const url = "https://github.com/isomorphic-git/isomorphic-git";
            const branch = "main";

            await spider.downloadRepo(url, tempDir, branch);

            // Only checks if .git folder exists
            const gitDirExists = fs.existsSync(path.join(tempDir, ".git"));
            expect(gitDirExists).toBe(true);
        }, 50000);
    });

    describe("downloadAuthor", () => {
        it("downloads author data", async () => {
            const authorData = await spider.downloadAuthor(tempDir);

            // Check if the data was returned
            expect(authorData).toBeDefined();

            // Extract the data for the LICENSE.md file
            const licenseData = authorData.get('LICENSE.md');

            // Check if data for LICENSE.md is present and in the correct format
            if (!(Array.isArray(licenseData) && licenseData.length > 0)) {
                fail("No data for LICENSE.md or data is not in the expected format");
            }

            // This data is specific to the LICENSE.md file and can differ per version
            const expectedAuthor = "William Hilton";
            const expectedEmail = "<wmhilton@gmail.com>";

            expect(licenseData[0].commit.author).toBe(expectedAuthor);
            expect(licenseData[0].commit.authorMail).toBe(expectedEmail);
            console.log(licenseData[0].numLines);
        }, 600000);
    });

    describe("updateVersion", () => {
        it("updates the version, deletes unchanged files and keeps changed files", async () => {
            const prevTag = "v1.23.0";
            const newTag = "v1.24.0";

            // Get all current files
            const initialFiles = await spider.getAllFiles(tempDir);

            // updateVersion returns the unchanged files
            const unchangedFiles = await spider.updateVersion(prevTag, newTag, tempDir, initialFiles);

            // Check if all the unchanged files were deleted.
            for (const file of unchangedFiles) {
                const exists = fs.existsSync(path.join(tempDir, file));
                expect(exists).toBe(false);
            }

            // Get the new list of files after the update
            const currentFiles = await spider.getAllFiles(tempDir);

            // The remaining files should all be part of the changed files
            for (const file of currentFiles) {
                expect(initialFiles.includes(file)).toBe(false);
                expect(unchangedFiles.includes(file)).toBe(false);
            }
        }, 100000);
    });

    describe("switchVersion", () => {
        it("switches to a different version", async () => {
            const tag = "v1.19.3";

            await spider.switchVersion(tag, tempDir);

            // Get the current HEAD of the repository
            const currentHead = await git.resolveRef({ fs, dir: tempDir, ref: 'HEAD' });

            // Get the commit hash that the tag points to
            const tagCommit = await git.resolveRef({ fs, dir: tempDir, ref: `refs/tags/${tag}` });

            // Check if the current HEAD matches the commit the tag points to
            expect(currentHead).toBe(tagCommit);
        }, 30000);
    });
});
