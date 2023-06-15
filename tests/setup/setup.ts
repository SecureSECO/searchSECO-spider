// Override with local test environment variables if they exist
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config({ path: `.env.test.local`, override: true });
