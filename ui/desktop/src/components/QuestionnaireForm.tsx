import { useMemo, useState, type FormEvent } from 'react';
import { defineMessages, useIntl } from '../i18n';
import {
  OTHER_OPTION_LABEL,
  questionnaireFormData,
  questionnaireIsComplete,
  type Questionnaire,
  type QuestionnaireOption,
} from '../utils/questionnaireSchema';
import { Button } from './ui/button';
import { cn } from '../utils';

const i18n = defineMessages({
  other: {
    id: 'elicitationRequest.other',
    defaultMessage: 'Other',
  },
  otherPlaceholder: {
    id: 'elicitationRequest.otherPlaceholder',
    defaultMessage: 'Type your answer',
  },
  notesLabel: {
    id: 'elicitationRequest.notesLabel',
    defaultMessage: 'Optional Instructions',
  },
  notesPlaceholder: {
    id: 'elicitationRequest.notesPlaceholder',
    defaultMessage: 'Extra context, constraints, or comments',
  },
  recommended: {
    id: 'elicitationRequest.recommended',
    defaultMessage: 'Recommended',
  },
  selectAllThatApply: {
    id: 'elicitationRequest.selectAllThatApply',
    defaultMessage: '(select all that apply)',
  },
  answerAllHint: {
    id: 'elicitationRequest.answerAllHint',
    defaultMessage: 'Answer every question to enable Submit',
  },
  submit: {
    id: 'elicitationRequest.submit',
    defaultMessage: 'Submit',
  },
  skip: {
    id: 'elicitationRequest.skip',
    defaultMessage: 'Skip',
  },
});

interface QuestionnaireFormProps {
  questionnaire: Questionnaire;
  onSubmit: (data: Record<string, unknown>) => void;
  onSkip?: () => void;
  submitLabel?: string;
  skipLabel?: string;
  disabled?: boolean;
}

function renderOptionCard(
  option: QuestionnaireOption,
  isSelected: boolean,
  isRecommended: boolean,
  disabled: boolean,
  recommendedLabel: string,
  onSelect: () => void
) {
  return (
    <button
      key={option.label}
      type="button"
      disabled={disabled}
      aria-pressed={isSelected}
      onClick={onSelect}
      className={cn(
        'rounded-[10px] border-[1.5px] px-3.5 py-2.5 text-left transition-colors',
        'border-border-primary hover:border-blue-400/80',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
        'disabled:cursor-not-allowed disabled:opacity-50',
        isSelected && 'border-blue-500 bg-blue-500/10 dark:bg-blue-500/15'
      )}
    >
      <div className="flex items-center gap-2 font-semibold text-text-primary">
        <span>{option.label}</span>
        {isRecommended && (
          <span className="text-xs font-medium text-blue-500">{`(${recommendedLabel})`}</span>
        )}
      </div>
      {option.description && (
        <div className="mt-1 text-[12.5px] leading-snug text-text-secondary">
          {option.description}
        </div>
      )}
    </button>
  );
}

export default function QuestionnaireForm({
  questionnaire,
  onSubmit,
  onSkip,
  submitLabel,
  skipLabel,
  disabled = false,
}: QuestionnaireFormProps) {
  const intl = useIntl();
  const [selected, setSelected] = useState<string[][]>(() => questionnaire.questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questionnaire.questions.map(() => ''));
  const [notes, setNotes] = useState('');

  const complete = useMemo(
    () => questionnaireIsComplete(questionnaire, selected, other),
    [questionnaire, selected, other]
  );

  const toggleOption = (questionIndex: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((entry) => [...entry]);
      const current = next[questionIndex] ?? [];
      if (multi) {
        next[questionIndex] = current.includes(label)
          ? current.filter((value) => value !== label)
          : [...current, label];
      } else {
        next[questionIndex] = [label];
      }
      return next;
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete || disabled) {
      return;
    }
    onSubmit(questionnaireFormData(questionnaire, selected, other, notes));
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {questionnaire.questions.map((question, questionIndex) => {
        const chosen = selected[questionIndex] ?? [];
        return (
          <fieldset key={question.key ?? question.title} className="min-w-0 border-0 p-0">
            <legend className="mb-2.5 text-[15px] font-semibold leading-snug text-text-primary">
              {question.title}
              {question.multi && (
                <span className="ml-2 text-xs font-medium text-text-secondary">
                  {intl.formatMessage(i18n.selectAllThatApply)}
                </span>
              )}
            </legend>
            <div className="flex flex-col gap-2" role="group">
              {question.options.map((option) =>
                renderOptionCard(
                  option,
                  chosen.includes(option.label),
                  option.label === question.recommended,
                  disabled,
                  intl.formatMessage(i18n.recommended),
                  () => toggleOption(questionIndex, option.label, question.multi)
                )
              )}
              {question.otherKey &&
                !question.options.some((option) => option.label === OTHER_OPTION_LABEL) &&
                renderOptionCard(
                  { label: intl.formatMessage(i18n.other), description: '' },
                  chosen.includes(OTHER_OPTION_LABEL),
                  false,
                  disabled,
                  intl.formatMessage(i18n.recommended),
                  () => toggleOption(questionIndex, OTHER_OPTION_LABEL, question.multi)
                )}
            </div>
            {question.otherKey && chosen.includes(OTHER_OPTION_LABEL) && (
              <label className="mt-2.5 flex flex-col gap-1.5">
                <span className="sr-only">{intl.formatMessage(i18n.other)}</span>
                <input
                  type="text"
                  value={other[questionIndex] ?? ''}
                  disabled={disabled}
                  autoFocus
                  placeholder={intl.formatMessage(i18n.otherPlaceholder)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOther((prev) => {
                      const next = [...prev];
                      next[questionIndex] = value;
                      return next;
                    });
                  }}
                  className="flex h-9 w-full rounded-md border bg-background-primary px-3 py-1 text-sm text-text-primary placeholder:text-text-secondary placeholder:font-light focus:border-border-secondary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </label>
            )}
          </fieldset>
        );
      })}

      {questionnaire.notesKey && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.notesLabel)}</span>
          <textarea
            value={notes}
            disabled={disabled}
            rows={2}
            placeholder={intl.formatMessage(i18n.notesPlaceholder)}
            onChange={(event) => setNotes(event.target.value)}
            className="w-full resize-y rounded-md border bg-background-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary placeholder:font-light focus:border-border-secondary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={disabled || !complete} className="min-w-24">
          {submitLabel ?? intl.formatMessage(i18n.submit)}
        </Button>
        {onSkip && (
          <button
            type="button"
            disabled={disabled}
            onClick={onSkip}
            className="text-sm text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-50"
          >
            {skipLabel ?? intl.formatMessage(i18n.skip)}
          </button>
        )}
      </div>
      {!complete && (
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.answerAllHint)}</p>
      )}
    </form>
  );
}
