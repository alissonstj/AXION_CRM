import { describe, it, expect } from 'vitest';
import { substituteMessageVariables } from './message-variables';

describe('substituteMessageVariables', () => {
  it('replaces #primeiroNome with the first word of the contact name', () => {
    const out = substituteMessageVariables('Oi #primeiroNome, tudo bem?', { name: 'Alisson Alves' });
    expect(out).toBe('Oi Alisson, tudo bem?');
  });

  it('replaces #nomeCompleto with the full contact name', () => {
    const out = substituteMessageVariables('Prezado #nomeCompleto', { name: 'Alisson Alves' });
    expect(out).toBe('Prezado Alisson Alves');
  });

  it('replaces every occurrence, not just the first', () => {
    const out = substituteMessageVariables('#primeiroNome, aqui é a equipe. #primeiroNome, obrigado!', { name: 'Ana' });
    expect(out).toBe('Ana, aqui é a equipe. Ana, obrigado!');
  });

  it('replaces both tokens in the same text', () => {
    const out = substituteMessageVariables('#primeiroNome (#nomeCompleto)', { name: 'Ana Silva' });
    expect(out).toBe('Ana (Ana Silva)');
  });

  it('collapses a single-word name — first and full name are the same', () => {
    const out = substituteMessageVariables('#primeiroNome / #nomeCompleto', { name: 'Ana' });
    expect(out).toBe('Ana / Ana');
  });

  it('replaces with an empty string when the contact has no name (null, undefined, or blank)', () => {
    expect(substituteMessageVariables('Oi #primeiroNome!', { name: null })).toBe('Oi !');
    expect(substituteMessageVariables('Oi #primeiroNome!', { name: undefined })).toBe('Oi !');
    expect(substituteMessageVariables('Oi #primeiroNome!', { name: '   ' })).toBe('Oi !');
  });

  it('leaves text with no tokens untouched', () => {
    const out = substituteMessageVariables('Mensagem sem variável nenhuma.', { name: 'Ana' });
    expect(out).toBe('Mensagem sem variável nenhuma.');
  });
});
