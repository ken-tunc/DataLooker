export const commandKeys = {
  all: ["connection-commands"] as const,
  running: () => [...commandKeys.all, "running"] as const,
};
