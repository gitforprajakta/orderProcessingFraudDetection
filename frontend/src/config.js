/**
 * Frontend configuration.
 *
 * After running `npx cdk deploy`, copy the four CloudFormation outputs into
 * the matching VITE_* env vars (preferred) or directly edit the defaults
 * below as a fallback.
 *
 *   ApiUrl                  -> VITE_API_URL
 *   AwsRegion               -> VITE_AWS_REGION
 *   CognitoUserPoolId       -> VITE_USER_POOL_ID
 *   CognitoUserPoolClientId -> VITE_USER_POOL_CLIENT_ID
 *
 * For local dev, create a frontend/.env.local file:
 *   VITE_API_URL=https://...
 *   VITE_AWS_REGION=us-west-1
 *   VITE_USER_POOL_ID=us-west-1_xxxxx
 *   VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxx
 */
const env = import.meta.env;

export const config = {
  apiUrl:
    env.VITE_API_URL ||
    "https://j6cq4fhg2i.execute-api.us-west-1.amazonaws.com/prod",
  awsRegion: env.VITE_AWS_REGION || "us-west-1",
  userPoolId: env.VITE_USER_POOL_ID || "REPLACE_AFTER_CDK_DEPLOY",
  userPoolClientId:
    env.VITE_USER_POOL_CLIENT_ID || "32skneju4gl7d07an9hkm5to33",
};

export default config;
