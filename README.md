# SearchSECO-Spider

This is the Spider of the SearchSECO project. The Spider is responsible for
retrieving data (source files and author data) from (Git-based) sources on the
internet and communicating this data to the Controller component of the system.
The spider needs a stable internet connection to the source in question to be
able to clone projects, to then process these locally.

## Usage

The Spider primarily serves as a submodule within the Controller. For detailed
instructions on integrating and utilizing the Spider in your system, please refer
to the Controller's documentation.

## Dependencies

Before running the Spider, ensure you have the following dependencies installed:

- Node.js: Spider is written in TypeScript, which runs on Node.js. Make sure you
  have Node.js installed in your system. You can download it from the [official Node.js website](https://nodejs.org/en).
- Git: As the Spider's main function is to clone and process projects from Git-based
  sources, Git needs to be installed on your system. If it's not already installed, you can download it from the [official Git website](https://git-scm.com/).
- Required Node.js Libraries: Install the required Node.js libraries by navigating to the project root and running `npm install`.

The specific versions required for these dependencies will be located in the project's package.json file. Please refer to this file for the most up-to-date information.

## License

This project is licensed under the MIT license. See [LICENSE](/LICENSE) for more info.

This program has been developed by students from the bachelor Computer Science at Utrecht University within the Software Project course. © Copyright Utrecht University (Department of Information and Computing Sciences)
