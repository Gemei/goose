import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionIndicators } from './SessionIndicators';

describe('SessionIndicators', () => {
  it('spins a status wheel while the session is streaming', () => {
    render(<SessionIndicators isStreaming hasUnread={false} hasError={false} />, {
      wrapper: IntlTestWrapper,
    });

    const spinner = screen.getByLabelText('Streaming');
    expect(spinner).toHaveClass('status-spinner');
  });
});
