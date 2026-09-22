export const agentKeys = {
  all: ["agents"] as const,
  access: () => [...agentKeys.all, "access"] as const,
};
