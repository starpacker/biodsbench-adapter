import { afterEach, describe, expect, test } from 'bun:test'
import {
  CYBER_RISK_MITIGATION_REMINDER,
  FileReadTool,
} from './FileReadTool.js'

const ENV_KEY = 'CLAUDE_CODE_EVAL_DISABLE_FILE_READ_MALWARE_REMINDER'
const previous = process.env[ENV_KEY]

afterEach(() => {
  if (previous === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = previous
  }
})

describe('FileReadTool eval harness rendering', () => {
  test('suppresses the malware reminder when source-native eval disables it', () => {
    process.env[ENV_KEY] = '1'
    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      {
        type: 'text',
        file: {
          filePath: 'public/README.md',
          content: '# Demo\n',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
      'tooluse_123',
    )

    expect(JSON.stringify(block)).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
    expect(JSON.stringify(block)).toContain('# Demo')
  })
})
