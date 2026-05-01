const fs = require("fs");
const path = require("path");

const stackName = "OrderProcessingFraudDetectionStack";
const rootDir = path.resolve(__dirname, "..");
const outputsPath = path.resolve(
  rootDir,
  process.env.STACK_OUTPUTS_FILE || "cdk-outputs.json"
);
const configPath = path.join(rootDir, "frontend", "config.js");

function readStackOutputs() {
  if (!fs.existsSync(outputsPath)) {
    throw new Error(`Missing ${outputsPath}. Run "npm run deploy" first or generate stack outputs during the frontend build.`);
  }

  const outputs = JSON.parse(fs.readFileSync(outputsPath, "utf8"));
  if (Array.isArray(outputs)) {
    return Object.fromEntries(
      outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue])
    );
  }

  if (outputs.ApiUrl && outputs.CognitoUserPoolClientId) {
    return outputs;
  }

  if (!outputs[stackName]) {
    throw new Error(
      `Stack outputs file does not include "${stackName}" or CloudFormation output entries.`
    );
  }

  return outputs[stackName];
}

function requiredOutput(outputs, key) {
  if (!outputs[key]) {
    throw new Error(`CDK output "${key}" is missing.`);
  }

  return outputs[key];
}

const outputs = readStackOutputs();
const config = {
  apiUrl: requiredOutput(outputs, "ApiUrl"),
  awsRegion: requiredOutput(outputs, "AwsRegion"),
  userPoolClientId: requiredOutput(outputs, "CognitoUserPoolClientId"),
  demoUsername: "testuser",
};

const content = `window.APP_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
fs.writeFileSync(configPath, content);

console.log(`Wrote ${path.relative(rootDir, configPath)}`);
