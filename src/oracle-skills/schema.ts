import { ORACLE_OPERATION_KINDS } from './types.js'
import { DEFAULT_MAX_ORACLE_OPERATIONS } from './limits.js'

const assetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string' },
  },
}

export const ORACLE_SKILL_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'task_id',
    'skill_name',
    'skill_description',
    'skill_overview',
    'operations',
    'self_check',
  ],
  properties: {
    schema_version: { const: 1 },
    task_id: { type: 'string', minLength: 1 },
    skill_name: { type: 'string', minLength: 1 },
    skill_description: { type: 'string', minLength: 1 },
    skill_overview: { type: 'string', minLength: 1 },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: DEFAULT_MAX_ORACLE_OPERATIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'title',
          'depends_on',
          'ablation_priority',
          'enabled_by_default',
          'source_refs',
          'skill_md',
          'resources',
          'scripts',
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ORACLE_OPERATION_KINDS },
          title: { type: 'string', minLength: 1 },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
          },
          ablation_priority: { type: 'number' },
          enabled_by_default: { const: true },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
          },
          skill_md: { type: 'string', minLength: 1 },
          resources: {
            type: 'array',
            items: assetSchema,
          },
          scripts: {
            type: 'array',
            items: assetSchema,
          },
        },
      },
    },
    self_check: {
      type: 'object',
      additionalProperties: false,
      required: [
        'atomicity_notes',
        'safety_notes',
        'likely_critical_ops',
        'likely_removable_ops',
      ],
      properties: {
        atomicity_notes: {
          type: 'array',
          items: { type: 'string' },
        },
        safety_notes: {
          type: 'array',
          items: { type: 'string' },
        },
        likely_critical_ops: {
          type: 'array',
          items: { type: 'string' },
        },
        likely_removable_ops: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  },
} as const
