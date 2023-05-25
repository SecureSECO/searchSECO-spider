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
        }, 600000);
    });

    describe("switchVersion", () => {
        it("switches to a different version", async () => {
            const tag = "v1.19.3";

            await spider.switchVersion(tag);

            // Get the current HEAD of the repository
            const currentHead = await git.resolveRef({ fs, dir: tempDir, ref: 'HEAD' });

            // Get the commit hash that the tag points to
            const tagCommit = await git.resolveRef({ fs, dir: tempDir, ref: `refs/tags/${tag}` });

            // Check if the current HEAD matches the commit the tag points to
            expect(currentHead).toBe(tagCommit);
        }, 30000);
    });
});