import { mapPiApiToProtocol } from './protocols.mjs';
import { uniqueStrings } from './util.mjs';

/**
 * A compact, curated fallback catalog. If pi-ai is installed, its generated
 * provider/model catalog takes precedence and these presets are merged in.
 */
const PRESETS = Object.freeze([
  {
    name: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    models: [
      'gpt-5.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o4-mini',
    ],
  },
  {
    name: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    models: [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-0',
    ],
  },
  {
    name: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'google',
    models: [
      'gemini-3-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    models: [
      'openai/gpt-5.1',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-pro-preview',
      'deepseek/deepseek-chat',
      'x-ai/grok-4',
    ],
  },
  {
    name: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    models: [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
      'qwen/qwen3-32b',
    ],
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    name: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
  },
  {
    name: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'codestral-latest',
      'ministral-8b-latest',
    ],
  },
  {
    name: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-32k'],
  },
  {
    name: 'zhipu',
    label: 'Z.ai / 智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
  },
  {
    name: 'dashscope',
    label: '阿里云百炼 / Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    models: ['qwen3-max', 'qwen-plus', 'qwen-flash'],
  },
  {
    name: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    protocol: 'openai',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
    ],
  },
  {
    name: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    protocol: 'openai',
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/qwen3-235b-a22b',
    ],
  },
  {
    name: 'ollama',
    label: 'Ollama (本机)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'ollama',
    models: ['qwen3:8b', 'llama3.3:latest', 'deepseek-r1:8b'],
  },
]);

const PI_AI_CANDIDATES = [
  {
    specifier: '@earendil-works/pi-ai/providers/all',
    kind: 'v1',
    hint: '@earendil-works/pi-ai',
  },
  {
    specifier: '@mariozechner/pi-ai',
    kind: 'legacy',
    hint: '@mariozechner/pi-ai',
  },
];

function clonePreset(preset) {
  return {
    ...preset,
    models: [...preset.models],
    source: 'builtin',
  };
}

function getBuiltinCatalog() {
  return {
    source: 'builtin',
    generatedAt: null,
    providers: PRESETS.map(clonePreset),
    piAi: { installed: piAiAvailability().installed, loaded: false },
  };
}

export function piAiAvailability() {
  if (typeof import.meta.resolve !== 'function') {
    return { installed: false, package: null, reason: '当前 Node 版本不支持模块解析探测' };
  }
  for (const candidate of PI_AI_CANDIDATES) {
    try {
      import.meta.resolve(candidate.specifier);
      return {
        installed: true,
        package: candidate.hint,
        specifier: candidate.specifier,
      };
    } catch {
      // Try the next package name.
    }
  }
  return { installed: false, package: null };
}

function prettyProviderName(id) {
  return String(id)
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function mergePiAiProvider(providerId, models, generatedAt) {
  const preset = PRESETS.find((item) => item.name === providerId);
  const modelIds = uniqueStrings(
    models
      .map((model) => (typeof model === 'string' ? model : model?.id))
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const first = models.find((model) => model && typeof model === 'object') ?? {};
  const baseUrl = preset?.baseUrl || first.baseUrl || '';
  const protocol = preset?.protocol || mapPiApiToProtocol(first.api);

  return {
    name: preset?.name || providerId,
    label: preset?.label || prettyProviderName(providerId),
    baseUrl,
    protocol,
    models: uniqueStrings([...modelIds, ...(preset?.models ?? [])]),
    source: 'pi-ai',
    generatedAt: generatedAt ?? null,
  };
}

async function readPiAiCatalog() {
  const failures = [];

  for (const candidate of PI_AI_CANDIDATES) {
    try {
      const module = await import(candidate.specifier);

      if (candidate.kind === 'v1') {
        if (
          typeof module.getBuiltinProviders !== 'function' ||
          typeof module.getBuiltinModels !== 'function'
        ) {
          failures.push(`${candidate.hint}: 未暴露 getBuiltinProviders/getBuiltinModels`);
          continue;
        }

        const generatedAt =
          typeof module.getBuiltinModelDataGeneratedAt === 'function'
            ? module.getBuiltinModelDataGeneratedAt() ?? null
            : null;
        const providerIds = module.getBuiltinProviders();
        const providers = [];

        for (const providerId of providerIds) {
          try {
            const models = module.getBuiltinModels(providerId);
            providers.push(mergePiAiProvider(providerId, models, generatedAt));
          } catch (error) {
            failures.push(`${candidate.hint}/${providerId}: ${error.message}`);
          }
        }

        return { providers, generatedAt, package: candidate.hint, failures };
      }

      if (candidate.kind === 'legacy') {
        if (
          typeof module.getProviders !== 'function' ||
          typeof module.getModels !== 'function'
        ) {
          failures.push(`${candidate.hint}: 未暴露 getProviders/getModels`);
          continue;
        }

        const providerIds = module.getProviders();
        const providers = [];
        for (const providerId of providerIds) {
          try {
            const models = module.getModels(providerId);
            providers.push(mergePiAiProvider(providerId, models, null));
          } catch (error) {
            failures.push(`${candidate.hint}/${providerId}: ${error.message}`);
          }
        }

        return { providers, generatedAt: null, package: candidate.hint, failures };
      }
    } catch (error) {
      failures.push(`${candidate.hint}: ${error.code || error.message}`);
    }
  }

  return { providers: null, package: null, failures };
}

function mergeCatalog(piAiResult) {
  const byName = new Map();

  for (const preset of PRESETS) {
    byName.set(preset.name, clonePreset(preset));
  }

  for (const provider of piAiResult.providers ?? []) {
    byName.set(provider.name, provider);
  }

  const providers = [...byName.values()].sort((a, b) => {
    const aPreset = PRESETS.some((preset) => preset.name === a.name);
    const bPreset = PRESETS.some((preset) => preset.name === b.name);
    if (aPreset !== bPreset) return aPreset ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    source: 'pi-ai',
    generatedAt: piAiResult.generatedAt ?? null,
    providers,
    piAi: {
      installed: true,
      loaded: true,
      package: piAiResult.package,
      failures: piAiResult.failures.slice(0, 20),
    },
  };
}

let catalogCache = {
  value: null,
  expiresAt: 0,
  promise: null,
};

const CATALOG_TTL_MS = 10 * 60 * 1000;

export async function getProviderCatalog({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && catalogCache.value && now < catalogCache.expiresAt) {
    return catalogCache.value;
  }
  if (!refresh && catalogCache.promise) {
    return catalogCache.promise;
  }

  const task = (async () => {
    const availability = piAiAvailability();
    if (!availability.installed) {
      const value = getBuiltinCatalog();
      value.piAi = { ...availability, loaded: false };
      return value;
    }

    const piAiResult = await readPiAiCatalog();
    if (!piAiResult.providers) {
      const value = getBuiltinCatalog();
      value.piAi = {
        installed: true,
        loaded: false,
        package: availability.package,
        error: piAiResult.failures.slice(0, 5).join('\n'),
      };
      return value;
    }

    return mergeCatalog(piAiResult);
  })();

  catalogCache.promise = task;
  try {
    const value = await task;
    catalogCache.value = value;
    catalogCache.expiresAt = Date.now() + CATALOG_TTL_MS;
    return value;
  } finally {
    if (catalogCache.promise === task) catalogCache.promise = null;
  }
}
