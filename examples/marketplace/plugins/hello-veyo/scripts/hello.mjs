// Runs in a visible Veyo terminal with the project folder as its working directory.
const project = process.argv[2] || process.cwd();
console.log(`Hello from the hello-veyo plugin.\nProject: ${project}`);
