import { ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { COMPUTER_USE_FLAG_ID } from '#/features/computerUse/computerUse';
import { ICompletionCriteriaService } from '#/features/computerUse/completionCriteriaService';
import {
  ComputerUseFeature,
  isComputerUseFeatureAssembled,
} from '#/features/computerUse/computerUseFeature';
import { beforeEach, describe, expect, it } from 'vitest';

import { stubFlag } from '../../app/flag/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('ComputerUseFeature - experimental flag gating', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(ComputerUseFeature);
  });

  it('contributes no computer tools when the flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');

    expect(manager.units().map((unit) => unit.name)).toEqual(['computerUse']);
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('still registers the criteria service with the flag off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);

    expect(manager.contributedServices()).toHaveLength(1);
    expect(manager.contributedServices()[0]?.id).toBe(ICompletionCriteriaService);
    host.dispose();
  });

  it('contributes the five computer tools when the flag is on', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === COMPUTER_USE_FLAG_ID)],
    ]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');

    const tools = collectionViewOf(agent, AgentToolContribution).items.map((record) =>
      record.options.name,
    );

    expect(tools.toSorted()).toEqual(
      ['ComputerApplication', 'ComputerClick', 'ComputerKey', 'ComputerScreenshot', 'ComputerType'].toSorted(),
    );
    host.dispose();
  });

  it('tags every contributed tool with the computer domain', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === COMPUTER_USE_FLAG_ID)],
    ]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');

    const domains = new Set(
      collectionViewOf(agent, AgentToolContribution).items.map((record) => record.options.domain),
    );

    expect([...domains]).toEqual(['computer']);
    host.dispose();
  });

  it('marks the feature assembled only while the flag is on', () => {
    const flags = stubFlag((id) => id === COMPUTER_USE_FLAG_ID);
    const host = createScopedTestHost([[IFlagService, flags]]);

    expect(isComputerUseFeatureAssembled(flags)).toBe(true);

    host.dispose();
  });

  it('reports not-assembled when the flag is off', () => {
    const flags = stubFlag(false);
    const host = createScopedTestHost([[IFlagService, flags]]);

    expect(isComputerUseFeatureAssembled(flags)).toBe(false);

    host.dispose();
  });
});
