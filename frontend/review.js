const reviewForm = document.getElementById("reviewForm");
const reviewOrderId = document.getElementById("reviewOrderId");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const approveBtn = document.getElementById("approveBtn");
const rejectBtn = document.getElementById("rejectBtn");
const output = document.getElementById("output");

const APP_CONFIG = window.APP_CONFIG || {};

function renderOutput(data) {
  output.textContent = JSON.stringify(data, null, 2);
}

function cleanOrderId(value) {
  return value.trim().replace(/[^0-9a-f-]/gi, "");
}

function getRequiredConfigValue(key) {
  const value = APP_CONFIG[key];
  if (!value) {
    throw new Error(`Missing frontend config value: ${key}. Redeploy CDK to regenerate config.js.`);
  }
  return value;
}

function getAuthCredentials() {
  const username = authUsername.value.trim();
  const password = authPassword.value;

  if (!username || !password) {
    throw new Error("Enter the Cognito username and password.");
  }

  return { username, password };
}

async function getIdToken() {
  const { username, password } = getAuthCredentials();
  const awsRegion = getRequiredConfigValue("awsRegion");
  const userPoolClientId = getRequiredConfigValue("userPoolClientId");

  const response = await fetch(`https://cognito-idp.${awsRegion}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: userPoolClientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Cognito auth failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const token = body.AuthenticationResult?.IdToken;
  if (!token) {
    throw new Error(`Cognito response did not include IdToken: ${JSON.stringify(body)}`);
  }

  return token;
}

async function submitReviewDecision(orderId, action, idToken) {
  const endpoint = `${getRequiredConfigValue("apiUrl")}/reviews/${encodeURIComponent(orderId)}/decision`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: idToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  });

  const rawText = await response.text();
  let body = rawText;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    // Keep raw text if response is not valid JSON.
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
    endpoint,
  };
}

function setButtonsDisabled(disabled) {
  approveBtn.disabled = disabled;
  rejectBtn.disabled = disabled;
}

const params = new URLSearchParams(window.location.search);
const orderIdFromLink = params.get("orderId");
if (orderIdFromLink) {
  reviewOrderId.value = cleanOrderId(orderIdFromLink);
}
if (APP_CONFIG.demoUsername) {
  authUsername.value = APP_CONFIG.demoUsername;
}

reviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submitter = event.submitter;
  const action = submitter?.value || "APPROVE";
  const orderId = cleanOrderId(reviewOrderId.value);
  reviewOrderId.value = orderId;

  setButtonsDisabled(true);
  renderOutput({
    status: "Submitting review decision...",
    orderId,
    action: action === "BLOCK" ? "REJECT" : action,
  });

  try {
    const idToken = await getIdToken();
    authPassword.value = "";
    const result = await submitReviewDecision(orderId, action, idToken);

    renderOutput({
      status: result.ok ? "Review decision submitted" : "Review decision failed",
      result: result.body,
      response: {
        ok: result.ok,
        status: result.status,
        endpoint: result.endpoint,
      },
      nextStep: result.ok
        ? "DynamoDB fraudDecision/status were updated and the SQS review message was removed."
        : "Check the response details below.",
    });
  } catch (error) {
    renderOutput({
      error: "Could not submit review decision.",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setButtonsDisabled(false);
  }
});
