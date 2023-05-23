// Override with local test environment variables if they exist
require("dotenv").config({ path: `.env.test.local`, override: true });
