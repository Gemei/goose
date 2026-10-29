import type { JsonSchema } from '../components/ui/JsonSchemaForm';

export const NOTES_FIELD_KEY = 'Notes (optional)';
export const INSTRUCTIONS_FIELD_KEY = 'Optional Instructions';
export const OTHER_OPTION_LABEL = 'Other';
const CHOOSE_ONE_MARKER = '\nChoose one:\n';
const SUGGESTED_RE = /\n?\(Suggested:\s*(.+?)\)\s*$/;
const OPTION_OF_PREFIX = 'Option of: ';
const OTHER_FOR_PREFIX = 'Other (for: ';

export interface QuestionnaireOption {
  label: string;
  description: string;
  /** Schema property name for multi-select booleans. */
  field?: string;
}

export interface QuestionnaireQuestion {
  title: string;
  multi: boolean;
  options: QuestionnaireOption[];
  recommended?: string;
  /** Schema property name for single-select enum. */
  key?: string;
  otherKey?: string;
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  notesKey?: string;
}

interface JsonSchemaOneOfOption {
  const?: string;
  title?: string;
  description?: string | null;
}

interface JsonSchemaProperty {
  type?: string;
  description?: string | null;
  enum?: string[] | null;
  oneOf?: JsonSchemaOneOfOption[];
}

function propertyDescription(prop: JsonSchemaProperty): string {
  return prop.description ?? '';
}

function enumChoices(
  prop: JsonSchemaProperty
): { labels: string[]; descriptions: Map<string, string> } | undefined {
  if (Array.isArray(prop.enum) && prop.enum.length >= 2) {
    return { labels: prop.enum, descriptions: new Map() };
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length >= 2) {
    const labels: string[] = [];
    const descriptions = new Map<string, string>();
    for (const option of prop.oneOf) {
      const label = (option.title || option.const || '').trim();
      if (!label) {
        continue;
      }
      labels.push(label);
      if (option.description) {
        descriptions.set(label, option.description);
      }
    }
    if (labels.length < 2) {
      return undefined;
    }
    return { labels, descriptions };
  }
  return undefined;
}

function isOtherKey(key: string): boolean {
  return key.startsWith(OTHER_FOR_PREFIX);
}

function isNotesKey(key: string): boolean {
  return key === INSTRUCTIONS_FIELD_KEY || key === NOTES_FIELD_KEY;
}

function otherForTitle(key: string): string | undefined {
  if (!isOtherKey(key)) {
    return undefined;
  }
  let inner = key.slice(OTHER_FOR_PREFIX.length);
  if (inner.endsWith(')')) {
    inner = inner.slice(0, -1);
  }
  inner = inner.replace(/…$/, '').trim();
  return inner || undefined;
}

function titlesMatch(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function takeMatchingOtherKey(
  leftover: Map<string, string>,
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const [title, key] of leftover) {
    if (candidates.some((candidate) => candidate && titlesMatch(title, candidate))) {
      leftover.delete(title);
      return key;
    }
  }
  return undefined;
}

function parseSuggested(description: string): { text: string; recommended?: string } {
  const match = SUGGESTED_RE.exec(description);
  if (!match) {
    return { text: description };
  }
  return {
    text: description.slice(0, match.index).trimEnd(),
    recommended: match[1].trim(),
  };
}

function parseOptionBullets(block: string, labels: readonly string[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  const lines = block.split('\n').map((line) => line.trim());
  const sep = ' — ';

  for (const label of labels) {
    const exact = `• ${label}`;
    const withDesc = `• ${label}${sep}`;
    for (const line of lines) {
      if (line === exact) {
        descriptions.set(label, '');
        break;
      }
      if (line.startsWith(withDesc)) {
        descriptions.set(label, line.slice(withDesc.length));
        break;
      }
    }
  }

  return descriptions;
}

function parseSingleSelect(
  key: string,
  prop: JsonSchemaProperty
): QuestionnaireQuestion | undefined {
  const choices = enumChoices(prop);
  if (!choices) {
    return undefined;
  }
  const { labels } = choices;

  const description = propertyDescription(prop);
  const chooseAt = description.indexOf(CHOOSE_ONE_MARKER);
  const beforeChoose = chooseAt === -1 ? description : description.slice(0, chooseAt);
  const { text, recommended } = parseSuggested(beforeChoose.trim());
  const bullets =
    chooseAt === -1
      ? new Map<string, string>()
      : parseOptionBullets(description.slice(chooseAt + CHOOSE_ONE_MARKER.length), labels);

  const options: QuestionnaireOption[] = labels.map((label) => ({
    label,
    description: bullets.get(label) ?? choices.descriptions.get(label) ?? '',
  }));

  const title = text || key;
  const recommendedLabel = recommended && labels.includes(recommended) ? recommended : undefined;

  return {
    title,
    multi: false,
    options,
    recommended: recommendedLabel,
    key,
  };
}

function parseOptionOf(
  description: string | undefined
): { title: string; description: string } | undefined {
  if (!description?.startsWith(OPTION_OF_PREFIX)) {
    return undefined;
  }
  const rest = description.slice(OPTION_OF_PREFIX.length);
  const sep = ' — ';
  const at = rest.indexOf(sep);
  const title = (at === -1 ? rest : rest.slice(0, at)).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    description: at === -1 ? '' : rest.slice(at + sep.length).trim(),
  };
}

function optionOfTitle(description: string | undefined): string | undefined {
  return parseOptionOf(description)?.title;
}

function orderedPropertyKeys(schema: JsonSchema): string[] {
  const properties = schema.properties ?? {};
  const hinted = schema.propertyOrder ?? [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of hinted) {
    if (key in properties && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of Object.keys(properties)) {
    if (!seen.has(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function propertiesInKeyOrder(
  properties: Record<string, JsonSchemaProperty>,
  keys: string[]
): Record<string, JsonSchemaProperty> {
  const ordered: Record<string, JsonSchemaProperty> = {};
  for (const key of keys) {
    const prop = properties[key];
    if (prop) {
      ordered[key] = prop;
    }
  }
  return ordered;
}

function parseQuestionnaireFromProperties(
  properties: Record<string, JsonSchemaProperty>
): Questionnaire | undefined {
  const keys = Object.keys(properties);
  const questions: QuestionnaireQuestion[] = [];
  let notesKey: string | undefined;
  let i = 0;

  while (i < keys.length) {
    const key = keys[i];
    const prop = properties[key] ?? {};

    if (isNotesKey(key) && (prop.type === 'string' || prop.type === undefined)) {
      notesKey = key;
      i += 1;
      continue;
    }

    if (enumChoices(prop)) {
      const question = parseSingleSelect(key, prop);
      if (!question) {
        return undefined;
      }
      i += 1;
      const nextKey = keys[i];
      if (nextKey && isOtherKey(nextKey) && properties[nextKey]?.type !== 'boolean') {
        question.otherKey = nextKey;
        i += 1;
      }
      questions.push(question);
      continue;
    }

    if (prop.type === 'boolean') {
      const options: QuestionnaireOption[] = [];
      const optionOfTitles = new Set<string>();
      while (i < keys.length && properties[keys[i]]?.type === 'boolean') {
        const optionKey = keys[i];
        const optionProp = properties[optionKey] ?? {};
        const optionOf = parseOptionOf(propertyDescription(optionProp) || undefined);
        if (optionOf) {
          optionOfTitles.add(optionOf.title);
          options.push({
            label: optionKey,
            description: optionOf.description,
            field: optionKey,
          });
        } else {
          options.push({
            label: optionKey,
            description: propertyDescription(optionProp),
            field: optionKey,
          });
        }
        i += 1;
      }
      if (options.length < 2) {
        return undefined;
      }

      let title = optionOfTitles.size === 1 ? [...optionOfTitles][0] : '';
      let otherKey: string | undefined;
      const nextKey = keys[i];
      if (nextKey && isOtherKey(nextKey) && properties[nextKey]?.type !== 'boolean') {
        otherKey = nextKey;
        title = title || otherForTitle(nextKey) || '';
        i += 1;
      }
      if (!title) {
        title = `Question ${questions.length + 1}`;
      }
      questions.push({
        title,
        multi: true,
        options,
        otherKey,
      });
      continue;
    }

    if (isOtherKey(key) && questions.length > 0 && prop.type !== 'boolean') {
      const last = questions[questions.length - 1];
      if (!last.otherKey) {
        last.otherKey = key;
      }
      i += 1;
      continue;
    }

    return undefined;
  }

  if (questions.length === 0) {
    return undefined;
  }

  return notesKey ? { questions, notesKey } : { questions };
}

function parseQuestionnaireGrouped(
  properties: Record<string, JsonSchemaProperty>,
  keys: string[]
): Questionnaire | undefined {
  const notesKey = keys.includes(INSTRUCTIONS_FIELD_KEY)
    ? INSTRUCTIONS_FIELD_KEY
    : keys.includes(NOTES_FIELD_KEY)
      ? NOTES_FIELD_KEY
      : undefined;
  const otherByTitle = new Map<string, string>();
  const enumQuestions = new Map<string, { question: QuestionnaireQuestion; index: number }>();
  const boolGroups = new Map<string, { options: QuestionnaireOption[]; index: number }>();
  const unknown: string[] = [];

  keys.forEach((key, index) => {
    if (isNotesKey(key)) {
      return;
    }
    const prop = properties[key] ?? {};
    if (isOtherKey(key) && prop.type !== 'boolean') {
      const title = otherForTitle(key);
      if (title) {
        otherByTitle.set(title, key);
      }
      return;
    }
    if (enumChoices(prop)) {
      const question = parseSingleSelect(key, prop);
      if (question) {
        enumQuestions.set(key, { question, index });
      }
      return;
    }
    if (prop.type === 'boolean') {
      const optionOf = parseOptionOf(propertyDescription(prop) || undefined);
      const group = optionOf?.title ?? '';
      const existing = boolGroups.get(group);
      const option: QuestionnaireOption = {
        label: key,
        description: optionOf?.description ?? (optionOf ? '' : propertyDescription(prop)),
        field: key,
      };
      if (existing) {
        existing.options.push(option);
      } else {
        boolGroups.set(group, { options: [option], index });
      }
      return;
    }
    unknown.push(key);
  });

  if (unknown.length > 0) {
    return undefined;
  }

  const leftoverOthers = new Map(otherByTitle);
  const questions: { question: QuestionnaireQuestion; index: number }[] = [];

  for (const { question, index } of enumQuestions.values()) {
    const otherKey = takeMatchingOtherKey(leftoverOthers, question.title, question.key);
    if (otherKey) {
      question.otherKey = otherKey;
    }
    questions.push({ question, index });
  }

  for (const [groupTitle, group] of boolGroups) {
    if (group.options.length < 2) {
      return undefined;
    }
    let title = groupTitle;
    let otherKey = takeMatchingOtherKey(leftoverOthers, title || undefined);
    if (!otherKey && !title && leftoverOthers.size === 1) {
      const [onlyTitle, onlyKey] = [...leftoverOthers.entries()][0];
      title = onlyTitle;
      otherKey = onlyKey;
      leftoverOthers.delete(onlyTitle);
    }
    if (!title) {
      title = `Question ${questions.length + 1}`;
    }
    questions.push({
      question: {
        title,
        multi: true,
        options: group.options,
        otherKey,
      },
      index: group.index,
    });
  }

  if (questions.length === 0) {
    return undefined;
  }

  questions.sort((a, b) => a.index - b.index);
  const result: Questionnaire = { questions: questions.map((entry) => entry.question) };
  if (notesKey) {
    result.notesKey = notesKey;
  }
  return result;
}

export function parseQuestionnaire(schema: JsonSchema): Questionnaire | undefined {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return undefined;
  }
  const keys = orderedPropertyKeys(schema);
  return (
    parseQuestionnaireGrouped(schema.properties, keys) ??
    parseQuestionnaireFromProperties(propertiesInKeyOrder(schema.properties, keys))
  );
}

export function questionnaireFormData(
  questionnaire: Questionnaire,
  selected: readonly (readonly string[])[],
  other: readonly string[],
  notes: string
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  questionnaire.questions.forEach((question, index) => {
    const chosen = selected[index] ?? [];
    const otherSelected = chosen.includes(OTHER_OPTION_LABEL);
    const picked = chosen.filter((label) => label !== OTHER_OPTION_LABEL);
    if (question.multi) {
      const chosenSet = new Set(picked);
      for (const option of question.options) {
        if (option.field) {
          data[option.field] = chosenSet.has(option.label);
        }
      }
    } else if (question.key) {
      data[question.key] = picked[0] ?? '';
    }
    if (question.otherKey) {
      data[question.otherKey] = otherSelected ? (other[index] ?? '') : '';
    }
  });

  if (questionnaire.notesKey) {
    data[questionnaire.notesKey] = notes;
  }

  return data;
}

export function questionnaireIsComplete(
  questionnaire: Questionnaire,
  selected: readonly (readonly string[])[],
  other: readonly string[]
): boolean {
  return questionnaire.questions.every((question, index) => {
    const chosen = selected[index] ?? [];
    const otherSelected = chosen.includes(OTHER_OPTION_LABEL);
    const picked = chosen.filter((label) => label !== OTHER_OPTION_LABEL);
    const otherText = (other[index] ?? '').trim();
    if (picked.length > 0 && !otherSelected) {
      return true;
    }
    if (otherSelected) {
      return otherText.length > 0;
    }
    return false;
  });
}
