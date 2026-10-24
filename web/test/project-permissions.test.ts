import { describe, expect, test } from "bun:test";

import { isProjectTaskQueryForPrincipal, projectTaskQueryKeys } from "../src/features/projects/production-source";
import { permissionsForProjectMember } from "../src/features/projects/api";

const principalId = "user/current";

describe("project-scoped permissions", () => {
  test("derives independent permissions for each project", () => {
    const owner = permissionsForProjectMember([{ project_id: "project/owner", user_id: principalId, role: "owner", created_at: "" }], principalId);
    const operator = permissionsForProjectMember([{ project_id: "project/operator", user_id: principalId, role: "operator", created_at: "" }], principalId);
    const viewer = permissionsForProjectMember([{ project_id: "project/viewer", user_id: principalId, role: "viewer", created_at: "" }], principalId);

    expect(owner).toEqual({ role: "owner", canWrite: true, canManageProjects: true, isReadOnly: false });
    expect(operator).toEqual({ role: "operator", canWrite: true, canManageProjects: false, isReadOnly: false });
    expect(viewer).toEqual({ role: "viewer", canWrite: false, canManageProjects: false, isReadOnly: true });
  });

  test("fails closed when the current principal is not a project member", () => {
    expect(permissionsForProjectMember([{ project_id: "project/other", user_id: "user/other", role: "owner", created_at: "" }], principalId)).toEqual({
      role: null,
      canWrite: false,
      canManageProjects: false,
      isReadOnly: true
    });
  });
});

describe("project task query ownership", () => {
  test("scopes cache cleanup to the unauthorized principal", () => {
    const currentProjectQuery = { queryKey: projectTaskQueryKeys.projects(principalId) };
    const otherProjectQuery = { queryKey: projectTaskQueryKeys.projects("user/other") };

    expect(isProjectTaskQueryForPrincipal(currentProjectQuery, principalId)).toBe(true);
    expect(isProjectTaskQueryForPrincipal(otherProjectQuery, principalId)).toBe(false);
  });
});
