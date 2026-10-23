import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fixedBedrockConfiguration, createBedrockModel } from "../bedrock.js";

test("live SDK configuration pins personal login, Ohio, official endpoint and one attempt without loading credentials", async () => {
  const config = fixedBedrockConfiguration();
  assert.equal(config.region, "us-east-2");
  assert.equal(config.profile, "buildnextgen-personal");
  assert.equal(config.endpoint, "https://bedrock-runtime.us-east-2.amazonaws.com");
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.ignoreConfiguredEndpointUrls, true);
  assert.deepEqual(config.authSchemePreference, ["aws.auth#sigv4"]);
  assert.equal(typeof config.credentials, "function");
  assert.deepEqual((await config.httpAuthSchemeProvider!({} as never)).map(option => option.schemeId), ["aws.auth#sigv4"]);
  const model = createBedrockModel();
  assert.equal(typeof model.converse, "function"); // Factory is lazy; this performs no AWS request.
});

test("bearer or redirected login-cache overrides are rejected without logging values or reading credentials", () => {
  for (const key of ["AWS_BEARER_TOKEN_BEDROCK", "AWS_LOGIN_CACHE_DIRECTORY"] as const) {
    const previous = process.env[key];
    try {
      process.env[key] = "DO_NOT_PRINT_TEST_VALUE";
      assert.throws(fixedBedrockConfiguration, error => error instanceof Error && !error.message.includes("DO_NOT_PRINT_TEST_VALUE"));
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});

test("official SDK signs only the Ohio Converse endpoint using SigV4 and never retries a throttled mock response", async () => {
  // The fake request handler never opens a socket. Fake credentials override the
  // lazy named-login provider so no real profile/cache is read during this test.
  let attempts = 0;
  const client = new BedrockRuntimeClient({ ...fixedBedrockConfiguration(),
    credentials: { accessKeyId: "OFFLINE_TEST_ACCESS_KEY", secretAccessKey: "OFFLINE_TEST_SECRET" },
    requestHandler: { async handle(request: { hostname: string; path: string; headers: Record<string, string>; body?: unknown }) {
      attempts += 1;
      assert.equal(request.hostname, "bedrock-runtime.us-east-2.amazonaws.com");
      assert.match(request.path, /amazon.nova-lite-v1(?:%3A|:)0\/converse$/);
      assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=OFFLINE_TEST_ACCESS_KEY\//);
      assert.equal(request.headers.authorization.includes("Bearer"), false);
      const body = JSON.parse(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body as Uint8Array));
      assert.equal(body.inferenceConfig.maxTokens, 1024);
      return { response: { statusCode: 429, headers: { "content-type": "application/json", "x-amzn-errortype": "ThrottlingException" },
        body: Readable.from([JSON.stringify({ message: "Offline throttling test" })]) } };
    } },
  });
  try {
    await assert.rejects(client.send(new ConverseCommand({ modelId: "amazon.nova-lite-v1:0", messages: [{ role: "user", content: [{ text: "Offline test only." }] }], inferenceConfig: { maxTokens: 1024 } })), /Offline throttling test/);
    assert.equal(attempts, 1);
  } finally { client.destroy(); }
});
