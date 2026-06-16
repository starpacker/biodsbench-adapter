import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerVerifySkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { SKILL_FILES, SKILL_MD } =
    require('./verifyContent.js') as typeof import('./verifyContent.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : 'Verify a code change does what it should by running the app.'

  registerBundledSkill({
    name: 'verify',
    description,
    userInvocable: true,
    files: SKILL_FILES,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
