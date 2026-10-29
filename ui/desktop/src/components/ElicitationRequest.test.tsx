import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ActionRequired } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import ElicitationRequest from './ElicitationRequest';

const actionRequiredContent = {
  type: 'actionRequired',
  data: {
    actionType: 'elicitation',
    id: 'elicitation-1',
    message: 'Need more information',
    requested_schema: {
      type: 'object',
      properties: {},
    },
  },
} as ActionRequired & { type: 'actionRequired' };

type SubmitElicitationResponse = (
  elicitationId: string,
  userData: Record<string, unknown>,
  action?: 'accept' | 'decline'
) => Promise<boolean>;

function renderElicitationRequest(onSubmit: SubmitElicitationResponse) {
  return render(
    <ElicitationRequest
      isCancelledMessage={false}
      isClicked={false}
      actionRequiredContent={actionRequiredContent}
      onSubmit={onSubmit}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('ElicitationRequest', () => {
  it('shows submitted state when the response is accepted', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(onSubmit).toHaveBeenCalledWith('elicitation-1', {});
    expect(await screen.findByText('Information submitted')).toBeInTheDocument();
  });

  it('shows submitted state while the response is pending', async () => {
    let resolveSubmission: (value: boolean) => void = () => {};
    const submission = new Promise<boolean>((resolve) => {
      resolveSubmission = resolve;
    });
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockReturnValue(submission);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(screen.getByText('Information submitted')).toBeInTheDocument();

    await act(async () => {
      resolveSubmission(true);
      await submission;
    });
  });

  it('keeps the request actionable when no ACP request is pending', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(false);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request is no longer active. The extension will need to ask again.'
    );
    expect(screen.queryByText('Information submitted')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('renders clickable option cards for questionnaire schemas', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);
    const questionnaireContent = {
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'elicitation-2',
        message: 'I need a few decisions from you before I proceed:',
        requested_schema: {
          type: 'object',
          properties: {
            'Should admins still have an optional Reset MFA button?': {
              type: 'string',
              enum: ['Yes — keep optional admin reset', 'No — self-service email only'],
              description:
                'Should admins still have an optional Reset MFA button?\n(Suggested: Yes — keep optional admin reset)\nChoose one:\n• Yes — keep optional admin reset — Self-service email link is the normal path.\n• No — self-service email only — Remove admin reset entirely.',
            },
            'Other (for: Should admins still have an optional Reset MFA button?)': {
              type: 'string',
              description: 'Free text if none of the options fit. Optional.',
            },
          },
        },
      },
    } as ActionRequired & { type: 'actionRequired' };

    render(
      <ElicitationRequest
        isCancelledMessage={false}
        isClicked={false}
        actionRequiredContent={questionnaireContent}
        onSubmit={onSubmit}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Goose is asking')).toBeInTheDocument();
    expect(
      screen.getByText('Should admins still have an optional Reset MFA button?')
    ).toBeInTheDocument();
    expect(screen.getByText('Self-service email link is the normal path.')).toBeInTheDocument();
    expect(screen.getByText('(Recommended)')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /Yes — keep optional admin reset/ }));
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('elicitation-2', {
      'Should admins still have an optional Reset MFA button?': 'Yes — keep optional admin reset',
      'Other (for: Should admins still have an optional Reset MFA button?)': '',
    });
  });

  it('shows Other as a card and Optional Instructions in the old Other slot', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);
    const questionnaireContent = {
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'elicitation-4',
        message: 'Quick check-in',
        requested_schema: {
          type: 'object',
          properties: {
            'What would you like to do in this session with goose?': {
              type: 'string',
              enum: ['Help me build something', 'Just experimenting'],
              description:
                'What would you like to do in this session with goose?\nChoose one:\n• Help me build something\n• Just experimenting',
            },
            'Other (for: What would you like to do in this session with goose?)': {
              type: 'string',
              description: 'Free text if none of the options fit. Optional.',
            },
            'Optional Instructions': {
              type: 'string',
              description: 'OPTIONAL: extra context, constraints, or comments.',
            },
          },
        },
      },
    } as ActionRequired & { type: 'actionRequired' };

    render(
      <ElicitationRequest
        isCancelledMessage={false}
        isClicked={false}
        actionRequiredContent={questionnaireContent}
        onSubmit={onSubmit}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('button', { name: 'Other' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type your answer')).not.toBeInTheDocument();
    expect(screen.getByText('Optional Instructions')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Other' }));
    const otherInput = screen.getByPlaceholderText('Type your answer');
    expect(otherInput).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await userEvent.type(otherInput, 'make a visualization');
    expect(submit).toBeEnabled();

    await userEvent.type(
      screen.getByPlaceholderText('Extra context, constraints, or comments'),
      'keep it brief'
    );
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('elicitation-4', {
      'What would you like to do in this session with goose?': '',
      'Other (for: What would you like to do in this session with goose?)': 'make a visualization',
      'Optional Instructions': 'keep it brief',
    });
  });

  it('declines the request when Skip is pressed', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);
    const questionnaireContent = {
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'elicitation-3',
        message: 'Pick one',
        requested_schema: {
          type: 'object',
          properties: {
            color: { type: 'string', enum: ['red', 'blue'] },
          },
        },
      },
    } as ActionRequired & { type: 'actionRequired' };

    render(
      <ElicitationRequest
        isCancelledMessage={false}
        isClicked={false}
        actionRequiredContent={questionnaireContent}
        onSubmit={onSubmit}
      />,
      { wrapper: IntlTestWrapper }
    );

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSubmit).toHaveBeenCalledWith('elicitation-3', {}, 'decline');
    expect(await screen.findByText('Question skipped')).toBeInTheDocument();
  });
});
