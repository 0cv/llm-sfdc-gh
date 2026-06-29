import { env } from "node:process";

const OWNER_TOKEN_ENV: Record<string, string> = {
  komodohealth: "GITHUB_TOKEN_KOMODO",
};

function ownerTokenEnvNames(repo: string): string[] {
  const owner = repo.split("/")[0]?.toLowerCase();
  if (!owner) return [];

  const names = new Set<string>();
  const explicitName = OWNER_TOKEN_ENV[owner];
  if (explicitName) names.add(explicitName);

  const normalizedOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  names.add(`GITHUB_TOKEN_${normalizedOwner}`);
  return [...names];
}

export function githubTokenForRepo(repo: string): string | undefined {
  if (env.GH_TOKEN) return env.GH_TOKEN;

  for (const name of ownerTokenEnvNames(repo)) {
    const token = env[name];
    if (token) return token;
  }

  return env.GITHUB_TOKEN;
}

export function githubCommentTokenForRepo(repo: string): string | undefined {
  return env.GITHUB_COMMENT_TOKEN || env.GH_COMMENT_TOKEN || githubTokenForRepo(repo);
}

export function githubChecksTokenForRepo(repo: string): string | undefined {
  return (
    env.GITHUB_CHECKS_TOKEN ||
    env.GITHUB_COMMENT_TOKEN ||
    env.GH_COMMENT_TOKEN ||
    githubTokenForRepo(repo)
  );
}
