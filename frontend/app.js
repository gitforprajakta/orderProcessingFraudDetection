const orderForm = document.getElementById("orderForm");
const itemsContainer = document.getElementById("itemsContainer");
const addItemBtn = document.getElementById("addItemBtn");
const itemRowTemplate = document.getElementById("itemRowTemplate");
const output = document.getElementById("output");
const submitBtn = document.getElementById("submitBtn");

const APP_CONFIG = {
  apiUrl: "https://w6yswx6f02.execute-api.us-west-2.amazonaws.com/prod",
  awsRegion: "us-west-2",
  userPoolClientId: "7mskkpiid0qdjbvh3b0k0o60h5",
  username: "testuser",
  password: "YourSecurePassw0rd!",
};

function renderOutput(data) {
  output.textContent = JSON.stringify(data, null, 2);
}

function createItemRow(values = {}) {
  const fragment = itemRowTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".item-row");
  row.querySelector("input[name='sku']").value = values.sku || "";
  row.querySelector("input[name='qty']").value = values.qty || "1";
  row.querySelector("input[name='unitPrice']").value = values.unitPrice || "199.99";
  row.querySelector(".remove-item-btn").addEventListener("click", () => {
    row.remove();
  });
  return fragment;
}

function getItemsFromForm() {
  return Array.from(itemsContainer.querySelectorAll(".item-row")).map((row) => ({
    sku: row.querySelector("input[name='sku']").value.trim(),
    qty: Number(row.querySelector("input[name='qty']").value),
    unitPrice: Number(row.querySelector("input[name='unitPrice']").value),
  }));
}

addItemBtn.addEventListener("click", () => {
  itemsContainer.appendChild(createItemRow());
});

async function getIdToken() {
  const response = await fetch(
    `https://cognito-idp.${APP_CONFIG.awsRegion}.amazonaws.com/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: APP_CONFIG.userPoolClientId,
        AuthParameters: {
          USERNAME: APP_CONFIG.username,
          PASSWORD: APP_CONFIG.password,
        },
      }),
    }
  );

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

async function submitOrder(payload, idToken) {
  const endpoint = `${APP_CONFIG.apiUrl}/orders`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: idToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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

orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(orderForm);
  const items = getItemsFromForm();

  if (!items.length) {
    renderOutput({ error: "Please add at least one item." });
    return;
  }

  const payload = {
    items,
    currency: (formData.get("currency") || "USD").toString().trim(),
    shippingPostal: (formData.get("shippingPostal") || "").toString().trim(),
    shippingCountry: (formData.get("shippingCountry") || "").toString().trim(),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Running...";
  renderOutput({
    status: "Signing in to Cognito and submitting order...",
    payload,
  });

  try {
    const idToken = await getIdToken();
    const result = await submitOrder(payload, idToken);

    renderOutput({
      status: result.ok ? "Order submitted successfully" : "Order submission failed",
      order: result.body,
      nextStep:
        result.ok && result.body?.orderId
          ? "Fraud Lambda runs from EventBridge and updates this order in DynamoDB."
          : "Check the response details below.",
      fraudInputsUsed: {
        orderTotal: items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0),
        totalQuantity: items.reduce((sum, item) => sum + item.qty, 0),
        shippingCountry: payload.shippingCountry,
      },
      response: {
        ok: result.ok,
        status: result.status,
        endpoint: result.endpoint,
      },
    });
  } catch (error) {
    renderOutput({
      error: "Could not complete one-click order flow.",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Redeploy CDK once so the demo Cognito user is created automatically.",
    });
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Order and Run Fraud Check";
  }
});

itemsContainer.appendChild(
  createItemRow({
    sku: "GADGET-1",
    qty: 1,
    unitPrice: "199.99",
  })
);

