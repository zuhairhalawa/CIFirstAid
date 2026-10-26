import type { Detector } from './rule.js';
import { typescriptDetector } from './typescript.js';
import { jsTestDetector, suiteFailedToRun, testTimeout, eslintFailure, prettierFailure } from './tests.js';
import { pytestDetector, pythonTracebackDetector, pipRules } from './python.js';
import { npmRules } from './npm.js';
import { nodeRules, nodeStackDetector } from './node.js';
import { systemRules } from './system.js';
import { actionsRules } from './actions.js';
import { dockerBuildDetector, dockerRules } from './docker.js';
import { networkRules } from './network.js';
import { resourceRules } from './resources.js';
import { genericRules } from './generic.js';

export const ALL_DETECTORS: Detector[] = [
  typescriptDetector,
  jsTestDetector,
  suiteFailedToRun,
  testTimeout,
  eslintFailure,
  prettierFailure,
  pytestDetector,
  pythonTracebackDetector,
  ...pipRules,
  ...npmRules,
  ...nodeRules,
  nodeStackDetector,
  ...systemRules,
  ...actionsRules,
  dockerBuildDetector,
  ...dockerRules,
  ...networkRules,
  ...resourceRules,
  ...genericRules,
];

export type { Detector, DetectContext } from './rule.js';
