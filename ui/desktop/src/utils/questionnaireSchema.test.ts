import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../components/ui/JsonSchemaForm';
import {
  parseQuestionnaire,
  questionnaireFormData,
  questionnaireIsComplete,
} from './questionnaireSchema';

const mfaSurvey: JsonSchema = {
  type: 'object',
  properties: {
    'Should admins still have an optional “Reset MFA” button on the Users page?': {
      type: 'string',
      enum: ['Yes — keep optional admin reset', 'No — self-service email only'],
      description:
        'Should admins still have an optional “Reset MFA” button on the Users page?\n(Suggested: Yes — keep optional admin reset)\nChoose one:\n• Yes — keep optional admin reset — Self-service email link is the normal path; admins can still force a reset (e.g. locked-out user who can’t read mail).\n• No — self-service email only — Remove admin reset entirely; only username+password → email link.',
    },
    'Other (for: Should admins still have an optional “Reset MFA” button on the Users page?)': {
      type: 'string',
      description: 'Free text if none of the options fit. Optional.',
    },
    'After the user requests a reset (username + password), what should the email link do?': {
      type: 'string',
      enum: ['Open enrollment wizard only', 'Also allow finishing login after enroll'],
      description:
        'After the user requests a reset (username + password), what should the email link do?\n(Suggested: Open enrollment wizard only)\nChoose one:\n• Open enrollment wizard only — Link proves the reset request; user scans a new authenticator and confirms a code. No TOTP needed to open the link. Old TOTP stays invalid once reset is requested (or once the link is used).\n• Also allow finishing login after enroll — Same as recommended, then immediately issue access/refresh so they land in the app enrolled and signed in.',
    },
    'Other (for: After the user requests a reset (username + password), what should the email link do?)':
      {
        type: 'string',
        description: 'Free text if none of the options fit. Optional.',
      },
    'Notes (optional)': {
      type: 'string',
      description: 'OPTIONAL: extra context, constraints, or comments.',
    },
  },
};

describe('parseQuestionnaire', () => {
  it('parses Ask User single-select fields with bullets, Other, Suggested, and notes', () => {
    const questionnaire = parseQuestionnaire(mfaSurvey);
    expect(questionnaire).toBeDefined();
    expect(questionnaire?.notesKey).toBe('Notes (optional)');
    expect(questionnaire?.questions).toHaveLength(2);

    const first = questionnaire!.questions[0];
    expect(first.multi).toBe(false);
    expect(first.title).toBe(
      'Should admins still have an optional “Reset MFA” button on the Users page?'
    );
    expect(first.recommended).toBe('Yes — keep optional admin reset');
    expect(first.options[0]).toEqual({
      label: 'Yes — keep optional admin reset',
      description:
        'Self-service email link is the normal path; admins can still force a reset (e.g. locked-out user who can’t read mail).',
    });
    expect(first.otherKey).toContain('Other (for:');
  });

  it('groups consecutive booleans as a multi-select using Other (for: …) as the title', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        Email: {
          type: 'boolean',
          description: 'Self-service email link',
        },
        SMS: {
          type: 'boolean',
          description: 'Text message codes',
        },
        'Other (for: Which MFA factor(s)?)': {
          type: 'string',
          description: 'Free text if none of the options fit. Optional.',
        },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions).toHaveLength(1);
    expect(questionnaire?.questions[0]).toMatchObject({
      title: 'Which MFA factor(s)?',
      multi: true,
      otherKey: 'Other (for: Which MFA factor(s)?)',
    });
    expect(questionnaire?.questions[0].options.map((option) => option.label)).toEqual([
      'Email',
      'SMS',
    ]);
  });

  it('uses Option of: descriptions as the multi-select title', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        React: { type: 'boolean', description: 'Option of: Pick a framework' },
        Vue: { type: 'boolean', description: 'Option of: Pick a framework' },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions[0].title).toBe('Pick a framework');
    expect(questionnaire?.questions[0].options[0].description).toBe('');
  });

  it('parses a plain enum as option cards', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['red', 'blue'] },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions[0].options.map((option) => option.label)).toEqual([
      'red',
      'blue',
    ]);
  });

  it('returns undefined for a yes/no boolean plus notes schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        answer: { type: 'boolean', description: 'Answer to the yes/no question.' },
        notes: { type: 'string', description: 'OPTIONAL: extra context.' },
      },
      required: ['answer'],
    };

    expect(parseQuestionnaire(schema)).toBeUndefined();
  });

  it('still builds Grok cards when JSON property order is alphabetical', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        Chips: {
          type: 'boolean',
          description: 'Option of: Which snack categories do you want stocked in the lab?',
        },
        Fruit: {
          type: 'boolean',
          description: 'Option of: Which snack categories do you want stocked in the lab?',
        },
        'Notes (optional)': {
          type: 'string',
          description: 'OPTIONAL: extra context, constraints, or comments.',
        },
        'Other (for: Preferred test day for deploying chaos experiments?)': {
          type: 'string',
        },
        'Other (for: Which animal mascot should the team adopt?)': { type: 'string' },
        'Other (for: Which snack categories do you want stocked in the lab?)': {
          type: 'string',
        },
        'Preferred test day for deploying chaos experiments?': {
          type: 'string',
          enum: ['Never (chaos is a lifestyle)', 'Friday', 'Monday'],
          description:
            'Preferred test day for deploying chaos experiments?\n(Suggested: Never (chaos is a lifestyle))\nChoose one:\n• Never (chaos is a lifestyle)\n• Friday\n• Monday',
        },
        Soda: {
          type: 'boolean',
          description: 'Option of: Which snack categories do you want stocked in the lab?',
        },
        Sweets: {
          type: 'boolean',
          description: 'Option of: Which snack categories do you want stocked in the lab?',
        },
        'Which animal mascot should the team adopt?': {
          type: 'string',
          enum: ['Goose', 'Capybara', 'Corgi'],
          description:
            'Which animal mascot should the team adopt?\n(Suggested: Goose)\nChoose one:\n• Goose — The loyal, slightly honky classic\n• Capybara — Chill under pressure\n• Corgi — Maximum floof, minimum legs',
        },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire).toBeDefined();
    expect(questionnaire?.notesKey).toBe('Notes (optional)');
    expect(questionnaire?.questions).toHaveLength(3);
    expect(questionnaire?.questions.map((question) => question.title)).toEqual([
      'Which snack categories do you want stocked in the lab?',
      'Preferred test day for deploying chaos experiments?',
      'Which animal mascot should the team adopt?',
    ]);
    expect(questionnaire?.questions[0].multi).toBe(true);
    expect(questionnaire?.questions[0].options.map((option) => option.label)).toEqual([
      'Chips',
      'Fruit',
      'Soda',
      'Sweets',
    ]);
    expect(questionnaire?.questions[2].recommended).toBe('Goose');
    expect(questionnaire?.questions.every((question) => question.otherKey)).toBe(true);
  });

  it('parses Other-first alphabetical single-select as Grok cards', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        'Other (for: What would you like to do in this session with goose?)': {
          type: 'string',
          description: 'Free text if none of the options fit. Optional.',
        },
        'What would you like to do in this session with goose?': {
          type: 'string',
          enum: [
            'Just experimenting',
            'Help me build something',
            'Research something',
            'Manage my stuff',
          ],
          description:
            'What would you like to do in this session with goose?\n(Suggested: Just experimenting)\nChoose one:\n• Just experimenting — Try out tools, make a visualization, or just play around\n• Help me build something — Coding, automation, or project work\n• Research something — Find information, docs, or do web research\n• Manage my stuff — Organize files, pages, or notes somewhere',
        },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions).toHaveLength(1);
    expect(questionnaire?.questions[0]).toMatchObject({
      title: 'What would you like to do in this session with goose?',
      multi: false,
      recommended: 'Just experimenting',
      otherKey: 'Other (for: What would you like to do in this session with goose?)',
    });
    expect(questionnaire?.questions[0].options.map((option) => option.label)).toEqual([
      'Just experimenting',
      'Help me build something',
      'Research something',
      'Manage my stuff',
    ]);
    expect(questionnaire?.questions[0].options[0].description).toBe(
      'Try out tools, make a visualization, or just play around'
    );
  });

  it('parses truncated Other keys from long question titles as cards', () => {
    const q1 = '1. When do you do your best thinking and working?';
    const q2 = '2. If you could automate one annoying chore today, which one?';
    const q3 = '3. What fuels your coding sessions?';
    const truncatedOther2 =
      'Other (for: 2. If you could automate one annoying chore today, which on…';
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        [q1]: { type: 'string', enum: ['Morning', 'Afternoon', 'Evening', 'Late night'] },
        [q2]: { type: 'string', enum: ['Email', 'File chaos', 'Browser routines'] },
        [q3]: { type: 'string', enum: ['Coffee', 'Tea', 'Water'] },
        'Notes (optional)': { type: 'string' },
        [`Other (for: ${q1})`]: { type: 'string' },
        [truncatedOther2]: { type: 'string' },
        [`Other (for: ${q3})`]: { type: 'string' },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions).toHaveLength(3);
    expect(questionnaire?.notesKey).toBe('Notes (optional)');
    expect(questionnaire?.questions.map((question) => question.title)).toEqual([q1, q2, q3]);
    expect(questionnaire?.questions[1].otherKey).toBe(truncatedOther2);
  });

  it('parses ACP oneOf enums as option cards', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        color: {
          type: 'string',
          oneOf: [
            { const: 'red', title: 'Red', description: 'Warm' },
            { const: 'blue', title: 'Blue', description: 'Cool' },
          ],
        },
      },
    };

    const questionnaire = parseQuestionnaire(schema);
    expect(questionnaire?.questions[0].options).toEqual([
      { label: 'Red', description: 'Warm' },
      { label: 'Blue', description: 'Cool' },
    ]);
  });

  it('returns undefined for mixed free-text and enum fields', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: { type: 'string', enum: ['red', 'blue'] },
      },
    };

    expect(parseQuestionnaire(schema)).toBeUndefined();
  });
});

describe('questionnaireFormData', () => {
  it('writes enum values, other text, boolean flags, and notes', () => {
    const questionnaire = parseQuestionnaire(mfaSurvey)!;
    const data = questionnaireFormData(
      questionnaire,
      [['Yes — keep optional admin reset'], ['Other']],
      ['', 'maybe later'],
      'ship Friday'
    );

    expect(data).toEqual({
      'Should admins still have an optional “Reset MFA” button on the Users page?':
        'Yes — keep optional admin reset',
      'Other (for: Should admins still have an optional “Reset MFA” button on the Users page?)': '',
      'After the user requests a reset (username + password), what should the email link do?': '',
      'Other (for: After the user requests a reset (username + password), what should the email link do?)':
        'maybe later',
      'Notes (optional)': 'ship Friday',
    });
    expect(
      questionnaireIsComplete(
        questionnaire,
        [['Yes — keep optional admin reset'], ['Other']],
        ['', 'maybe later']
      )
    ).toBe(true);
    expect(
      questionnaireIsComplete(
        questionnaire,
        [['Yes — keep optional admin reset'], ['Other']],
        ['', '']
      )
    ).toBe(false);
    expect(
      questionnaireIsComplete(
        questionnaire,
        [['Yes — keep optional admin reset'], []],
        ['', 'maybe later']
      )
    ).toBe(false);
  });

  it('sets unselected multi-select options to false', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        Email: { type: 'boolean', description: 'Option of: Which MFA factor(s)?' },
        SMS: { type: 'boolean', description: 'Option of: Which MFA factor(s)?' },
      },
    };
    const questionnaire = parseQuestionnaire(schema)!;
    expect(questionnaireFormData(questionnaire, [['Email']], [''], '')).toEqual({
      Email: true,
      SMS: false,
    });
  });
});
