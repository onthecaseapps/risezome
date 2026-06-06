import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddSourceSection } from '../../app/(authed)/sources/_add-source';

function hrefFor(label: RegExp): string | null {
  return screen.getByRole('link', { name: label }).getAttribute('href');
}

describe('AddSourceSection', () => {
  it('always offers GitHub (add another org) and a disabled Slack stub', () => {
    render(<AddSourceSection trelloConnected={false} atlassianConnected={false} />);
    expect(hrefFor(/add another org/i)).toBe('/sources/install');
    const slack = screen.getByRole('button', { name: /connect slack/i });
    expect(slack).toBeDisabled();
  });

  it('offers Connect Trello + Connect Jira/Confluence when nothing is connected', () => {
    render(<AddSourceSection trelloConnected={false} atlassianConnected={false} />);
    expect(hrefFor(/connect trello/i)).toBe('/sources/trello/connect');
    expect(hrefFor(/connect jira/i)).toBe('/sources/atlassian/connect');
    expect(hrefFor(/connect confluence/i)).toBe('/sources/atlassian/connect');
  });

  it('drops Trello from the list once it is connected (it shows as a card above)', () => {
    render(<AddSourceSection trelloConnected={true} atlassianConnected={false} />);
    expect(screen.queryByRole('link', { name: /connect trello/i })).not.toBeInTheDocument();
    // Atlassian still offered.
    expect(screen.getByRole('link', { name: /connect jira/i })).toBeInTheDocument();
  });

  it('drops both Jira and Confluence once Atlassian is connected', () => {
    render(<AddSourceSection trelloConnected={false} atlassianConnected={true} />);
    expect(screen.queryByRole('link', { name: /connect jira/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /connect confluence/i })).not.toBeInTheDocument();
    // Trello still offered.
    expect(screen.getByRole('link', { name: /connect trello/i })).toBeInTheDocument();
  });
});
