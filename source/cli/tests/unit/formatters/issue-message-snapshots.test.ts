import { describe, it, expect } from 'vitest';
import {
  aspectStatusInvalidMessage,
  aspectStatusDowngradeMessage,
  impliesStatusInheritInvalidMessage,
  aspectNewlyActiveMessage,
  aspectViolationEnforcedMessage,
  aspectViolationAdvisoryMessage,
  approveAspectDraftScenarioAMessage,
  approveAspectDraftScenarioBMessage,
  approveNodeAllDraftMessage,
} from '../../../src/formatters/aspect-status-messages.js';

describe('aspect-status: issue-message snapshots', () => {
  it('aspect-status-invalid', () => {
    expect(
      aspectStatusInvalidMessage({
        aspectId: 'X',
        value: 'unstable',
        aspectDir: '.yggdrasil/aspects/X',
      })
    ).toMatchSnapshot();
  });

  it('aspect-status-downgrade', () => {
    expect(
      aspectStatusDowngradeMessage({
        nodePath: 'billing/cancel',
        aspectId: 'audit-log',
        declared: 'advisory',
        anchor: 'enforced',
        origin: 'flow:billing-flow',
      })
    ).toMatchSnapshot();
  });

  it('implies-status-inherit-invalid', () => {
    expect(
      impliesStatusInheritInvalidMessage({
        implierId: 'A',
        impliedId: 'B',
        value: 'lax',
        aspectDir: '.yggdrasil/aspects/A',
      })
    ).toMatchSnapshot();
  });

  it('aspect-newly-active (advisory)', () => {
    expect(
      aspectNewlyActiveMessage({
        aspectId: 'X',
        nodePath: 'Y',
        status: 'advisory',
      })
    ).toMatchSnapshot();
  });

  it('aspect-newly-active (enforced)', () => {
    expect(
      aspectNewlyActiveMessage({
        aspectId: 'X',
        nodePath: 'Y',
        status: 'enforced',
      })
    ).toMatchSnapshot();
  });

  it('aspect-violation-enforced', () => {
    expect(
      aspectViolationEnforcedMessage({
        aspectId: 'X',
        nodePath: 'Y',
        reason: 'too many params',
      })
    ).toMatchSnapshot();
  });

  it('aspect-violation-advisory', () => {
    expect(
      aspectViolationAdvisoryMessage({
        aspectId: 'X',
        nodePath: 'Y',
        reason: 'too many params',
      })
    ).toMatchSnapshot();
  });

  it('approve --aspect X Scenario A (aspect-default draft)', () => {
    expect(
      approveAspectDraftScenarioAMessage({
        aspectId: 'X',
      })
    ).toMatchSnapshot();
  });

  it('approve --aspect X Scenario B (per-node effective-draft)', () => {
    expect(
      approveAspectDraftScenarioBMessage({
        aspectId: 'X',
        nodePath: 'Y',
        origin: 'own:Y',
      })
    ).toMatchSnapshot();
  });

  it('approve --node Y (all aspects draft)', () => {
    expect(
      approveNodeAllDraftMessage({
        nodePath: 'Y',
      })
    ).toMatchSnapshot();
  });
});
