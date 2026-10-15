// Deliberately separate entrypoint. No production key, secret expression, or live fallback.
import { prepare } from './prepare.mjs';
import { executeValidation } from './validation-runner.mjs';
import { createMockScreenshots } from './mock-screenshots.mjs';
import { createOfflineBroker } from './mock-provider.cjs';
import { createOfflinePilotProof } from './offline-pilot-completion.mjs';
import { createMockHaruSession } from './mock-haru-session.mjs';
import { demand, safeCode } from './contract.mjs';
import { finishValidationProcess } from './run-finalization.mjs';
try {
  demand(!process.env.OFFERPILOT_REAL_AI_KEY, 'SECRET_PRESENT_DURING_PREPARATION');
  if (process.argv[2] === 'prepare') await prepare({ mode: 'mock' });
  else if (process.argv[2] === 'run') {
    const result = await executeValidation({ mode: 'mock', brokerFactory: createOfflineBroker,
      screenshotFactory: createMockScreenshots, mockPilotProofFactory: createOfflinePilotProof,
      mockHaruSessionFactory: createMockHaruSession });
    finishValidationProcess(result);
  } else demand(false, 'INVALID_HARNESS');
} catch (error) { console.error(`MOCK validation blocked: ${safeCode(error)}`); process.exitCode = 1; }
