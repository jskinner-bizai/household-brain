// No SDK client or credentials are created until an explicitly enabled live run invokes converse.
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import { fromLoginCredentials } from "@aws-sdk/credential-providers";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLANNER_MODEL_ID, PLANNER_PROFILE, PLANNER_REGION, type PlannerModel, type PlannerModelResponse } from "./planner.js";

function requireNamedLoginEnvironment(): void {
  // A distinct bearer key or redirected login cache is outside this demo's
  // existing named-profile authorization. Never print their values.
  if (process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_LOGIN_CACHE_DIRECTORY) {
    throw new Error("The bounded demo requires the existing named AWS login without credential overrides.");
  }
}

export function fixedBedrockConfiguration(): BedrockRuntimeClientConfig {
  requireNamedLoginEnvironment();
  return {
    region: PLANNER_REGION,
    profile: PLANNER_PROFILE,
    credentials: fromLoginCredentials({
      profile: PLANNER_PROFILE,
      filepath: join(homedir(), ".aws", "credentials"),
      configFilepath: join(homedir(), ".aws", "config"),
      ignoreCache: true,
      clientConfig: { region: PLANNER_REGION, maxAttempts: 1, ignoreConfiguredEndpointUrls: true },
    }),
    maxAttempts: 1,
    endpoint: `https://bedrock-runtime.${PLANNER_REGION}.amazonaws.com`,
    ignoreConfiguredEndpointUrls: true,
    authSchemePreference: ["aws.auth#sigv4"],
    // Restrict rather than merely prefer SigV4: never fall through to bearer
    // environment keys or another profile when the personal login fails.
    httpAuthSchemeProvider: () => [{
      schemeId: "aws.auth#sigv4",
      signingProperties: { name: "bedrock", region: PLANNER_REGION },
      propertiesExtractor: (config, context) => ({ signingProperties: { config, context } }),
    }],
  };
}

export function createBedrockModel(): PlannerModel {
  let client: BedrockRuntimeClient | undefined;
  return {
    async converse(input, signal) {
      requireNamedLoginEnvironment();
      if (input.modelId !== PLANNER_MODEL_ID || input.inferenceConfig.maxTokens !== 1024) throw new Error("Invalid bounded model configuration.");
      client ??= new BedrockRuntimeClient(fixedBedrockConfiguration());
      const command = new ConverseCommand(input as ConverseCommandInput);
      const result = await client.send(command, { abortSignal: signal });
      return {
        output: result.output as PlannerModelResponse["output"],
        stopReason: result.stopReason,
        usage: result.usage ? { inputTokens: result.usage.inputTokens!, outputTokens: result.usage.outputTokens! } : undefined,
      };
    },
  };
}
