import { useState, useEffect, useRef } from 'react';
import type { ActionRequired } from '../types/message';
import { defineMessages, useIntl } from '../i18n';
import { ACP_ELICITATION_TIMEOUT_SECONDS } from '../acp/elicitationRequests';
import { parseQuestionnaire } from '../utils/questionnaireSchema';
import { Button } from './ui/button';
import JsonSchemaForm from './ui/JsonSchemaForm';
import type { JsonSchema } from './ui/JsonSchemaForm';
import QuestionnaireForm from './QuestionnaireForm';

const i18n = defineMessages({
  cancelled: {
    id: 'elicitationRequest.cancelled',
    defaultMessage: 'Information request was cancelled.',
  },
  submitted: {
    id: 'elicitationRequest.submitted',
    defaultMessage: 'Information submitted',
  },
  skipped: {
    id: 'elicitationRequest.skipped',
    defaultMessage: 'Question skipped',
  },
  expired: {
    id: 'elicitationRequest.expired',
    defaultMessage: 'This request has expired. The extension will need to ask again.',
  },
  defaultMessage: {
    id: 'elicitationRequest.defaultMessage',
    defaultMessage: 'Goose needs some information from you.',
  },
  askingHeader: {
    id: 'elicitationRequest.askingHeader',
    defaultMessage: 'Goose is asking',
  },
  submit: {
    id: 'elicitationRequest.submit',
    defaultMessage: 'Submit',
  },
  skip: {
    id: 'elicitationRequest.skip',
    defaultMessage: 'Skip',
  },
  accept: {
    id: 'elicitationRequest.accept',
    defaultMessage: 'Accept',
  },
  waitingForResponse: {
    id: 'elicitationRequest.waitingForResponse',
    defaultMessage: 'Waiting for your response ({timeRemaining} remaining)',
  },
  submitError: {
    id: 'elicitationRequest.submitError',
    defaultMessage: 'This request is no longer active. The extension will need to ask again.',
  },
});

const ELICITATION_TIMEOUT_SECONDS = ACP_ELICITATION_TIMEOUT_SECONDS;

interface ElicitationRequestProps {
  isCancelledMessage: boolean;
  isDeclinedMessage?: boolean;
  isClicked: boolean;
  actionRequiredContent: ActionRequired & { type: 'actionRequired' };
  onSubmit: (
    elicitationId: string,
    userData: Record<string, unknown>,
    action?: 'accept' | 'decline'
  ) => Promise<boolean>;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function ElicitationRequest({
  isCancelledMessage,
  isDeclinedMessage = false,
  isClicked,
  actionRequiredContent,
  onSubmit,
}: ElicitationRequestProps) {
  const intl = useIntl();
  const [submitted, setSubmitted] = useState(isClicked);
  const [skipped, setSkipped] = useState(isDeclinedMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [timeRemaining, setTimeRemaining] = useState(ELICITATION_TIMEOUT_SECONDS);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (isClicked) {
      setSubmitted(true);
      setSubmitError(undefined);
    }
  }, [isClicked]);

  useEffect(() => {
    if (isDeclinedMessage) {
      setSkipped(true);
      setSubmitError(undefined);
    }
  }, [isDeclinedMessage]);

  useEffect(() => {
    if (submitted || skipped || isCancelledMessage || isClicked || isDeclinedMessage) return;

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const remaining = Math.max(0, ELICITATION_TIMEOUT_SECONDS - elapsed);
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [submitted, skipped, isCancelledMessage, isClicked, isDeclinedMessage]);

  if (actionRequiredContent.data.actionType !== 'elicitation') {
    return null;
  }

  const { id: elicitationId, message, requested_schema } = actionRequiredContent.data;

  const schema = (requested_schema ?? {}) as JsonSchema;
  const hasSchemaFields = Boolean(schema.properties && Object.keys(schema.properties).length > 0);
  const questionnaire = hasSchemaFields ? parseQuestionnaire(schema) : undefined;

  const submitResponse = async (
    formData: Record<string, unknown>,
    action: 'accept' | 'decline' = 'accept'
  ) => {
    if (action === 'decline') {
      setSkipped(true);
    } else {
      setSubmitted(true);
    }
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      const didSubmit =
        action === 'decline'
          ? await onSubmit(elicitationId, formData, 'decline')
          : await onSubmit(elicitationId, formData);
      if (!didSubmit) {
        setSubmitted(false);
        setSkipped(false);
        setSubmitError(intl.formatMessage(i18n.submitError));
      }
    } catch (error) {
      console.error('Error submitting elicitation response:', error);
      setSubmitted(false);
      setSkipped(false);
      setSubmitError(intl.formatMessage(i18n.submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = (formData: Record<string, unknown>) => {
    void submitResponse(formData);
  };

  const handleAccept = () => {
    void submitResponse({});
  };

  const handleSkip = () => {
    void submitResponse({}, 'decline');
  };

  if (isCancelledMessage) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        {intl.formatMessage(i18n.cancelled)}
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-gray-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span>{intl.formatMessage(i18n.submitted)}</span>
        </div>
      </div>
    );
  }

  if (skipped) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        <span>{intl.formatMessage(i18n.skipped)}</span>
      </div>
    );
  }

  const isUrgent = timeRemaining <= 60;
  const isExpired = timeRemaining === 0;

  if (isExpired) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        <div className="flex items-center gap-2 text-text-secondary">
          <svg
            className="w-5 h-5"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>{intl.formatMessage(i18n.expired)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="goose-message-content bg-background-secondary rounded-2xl rounded-b-none px-4 py-2 text-text-primary">
        {questionnaire ? (
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
            {intl.formatMessage(i18n.askingHeader)}
          </div>
        ) : (
          <div className="flex justify-between items-start gap-4">
            <span>{message || intl.formatMessage(i18n.defaultMessage)}</span>
          </div>
        )}
      </div>
      <div className="goose-message-content bg-background-primary border border-border-primary dark:border-gray-700 rounded-b-2xl px-4 py-3">
        {questionnaire ? (
          <QuestionnaireForm
            questionnaire={questionnaire}
            onSubmit={handleSubmit}
            onSkip={handleSkip}
            submitLabel={intl.formatMessage(i18n.submit)}
            skipLabel={intl.formatMessage(i18n.skip)}
            disabled={isSubmitting}
          />
        ) : hasSchemaFields ? (
          <JsonSchemaForm
            schema={schema}
            onSubmit={handleSubmit}
            onCancel={handleSkip}
            submitLabel={intl.formatMessage(i18n.submit)}
            cancelLabel={intl.formatMessage(i18n.skip)}
            disabled={isSubmitting}
          />
        ) : (
          <div className="flex gap-2">
            <Button type="button" onClick={handleAccept} disabled={isSubmitting}>
              {intl.formatMessage(i18n.accept)}
            </Button>
          </div>
        )}
        {submitError && (
          <div role="alert" className="mt-3 text-sm text-red-500">
            {submitError}
          </div>
        )}
        <div
          className={`mt-3 pt-3 border-t border-border-primary flex items-center gap-2 text-sm ${isUrgent ? 'text-red-500' : 'text-text-secondary'}`}
        >
          <svg
            className="w-4 h-4 animate-pulse"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>
            {intl.formatMessage(i18n.waitingForResponse, {
              timeRemaining: formatTime(timeRemaining),
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
