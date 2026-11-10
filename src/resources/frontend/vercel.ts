export const config = {
  git: {
    deploymentEnabled: {
      main: false,
    },
  },
  routes: [
    {
      src: "/(.*)",
      has: [
        {
          type: "header",
          key: "user-agent",
          value:
            ".*(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|CCBot|PerplexityBot|Perplexity-User|Bytespider|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|Diffbot|cohere-ai|YouBot|AI2Bot|DuckAssistBot|MistralAI-User|Timpibot|ImagesiftBot|omgili).*",
        },
      ],
      mitigate: {
        action: "deny",
      },
    },
  ],
};
