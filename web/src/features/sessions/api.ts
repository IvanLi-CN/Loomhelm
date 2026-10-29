import {
  createGeneratedApiClient,
  type GeneratedApiClient
} from "@loomhelm/api-client";

export interface PublishedSessionApi {
  createSession: GeneratedApiClient["createSession"];
  getSession: GeneratedApiClient["getSession"];
  submitRun: GeneratedApiClient["submitRun"];
  resolveApproval: GeneratedApiClient["resolveApproval"];
  interruptRun: GeneratedApiClient["interruptRun"];
  listRunEvents: GeneratedApiClient["listRunEvents"];
  getArtifact: GeneratedApiClient["getArtifact"];
  downloadArtifact: GeneratedApiClient["downloadArtifact"];
}

export function createPublishedSessionApi(client: GeneratedApiClient = createGeneratedApiClient()): PublishedSessionApi {
  return {
    createSession: (request) => client.createSession(request),
    getSession: (request) => client.getSession(request),
    submitRun: (request) => client.submitRun(request),
    resolveApproval: (request) => client.resolveApproval(request),
    interruptRun: (request) => client.interruptRun(request),
    listRunEvents: (request) => client.listRunEvents(request),
    getArtifact: (request) => client.getArtifact(request),
    downloadArtifact: (request) => client.downloadArtifact(request)
  };
}
