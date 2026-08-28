import {
  providerTransport,
  type ProviderTransportRequest,
  type ResolvedProviderContext,
} from '../provider-routing';
import {
  resolveInvocationRoute,
  type ModelRef,
  type ResolvedInvocationRoute,
} from '../../utils/settings-manager';
import type { ModelType } from '../../constants/model-config';
import { IMAGE_GENERATION_TIMEOUT_MS } from '../../constants/TASK_CONSTANTS';
import { resolveInvocationPlanFromRoute } from '../provider-routing';
import type { AdapterContext } from './types';

interface AdapterContextRouteOptions {
  bindingId?: string | null;
  preferredRequestSchema?: string | readonly string[] | null;
}

export const getAdapterContextFromSettings = (
  routeType: ModelType,
  modelId?: string | ModelRef | null,
  options: AdapterContextRouteOptions = {}
): AdapterContext => {
  const plan = resolveInvocationPlanFromRoute(routeType, modelId, options);
  if (plan) {
    return {
      baseUrl: plan.provider.baseUrl,
      operation: routeType,
      apiKey: plan.provider.apiKey,
      authType: plan.provider.authType,
      extraHeaders: plan.provider.extraHeaders,
      provider: plan.provider,
      binding: plan.binding,
    };
  }

  const route: ResolvedInvocationRoute = resolveInvocationRoute(
    routeType,
    modelId
  );
  return {
    baseUrl: route.baseUrl,
    operation: routeType,
    apiKey: route.apiKey,
    authType: 'bearer',
    provider: null,
    binding: null,
  };
};

export function buildProviderContextFromAdapterContext(
  context: AdapterContext,
  baseUrlOverride?: string
): ResolvedProviderContext {
  if (context.provider) {
    return {
      ...context.provider,
      baseUrl: baseUrlOverride || context.provider.baseUrl,
    };
  }

  return {
    profileId: 'runtime',
    profileName: 'Runtime',
    providerType: 'custom',
    baseUrl: baseUrlOverride || context.baseUrl,
    apiKey: context.apiKey || '',
    authType: context.authType || 'bearer',
    extraHeaders: context.extraHeaders,
  };
}

export function sendAdapterRequest(
  context: AdapterContext,
  request: ProviderTransportRequest,
  baseUrlOverride?: string
): Promise<Response> {
  const timeoutMs =
    request.timeoutMs ??
    (context.operation === 'image' ? IMAGE_GENERATION_TIMEOUT_MS : undefined);

  return providerTransport.send(
    buildProviderContextFromAdapterContext(context, baseUrlOverride),
    {
      ...request,
      timeoutMs,
      fetcher: context.fetcher || request.fetcher,
      taskId: context.taskId ?? request.taskId,
    }
  );
}
