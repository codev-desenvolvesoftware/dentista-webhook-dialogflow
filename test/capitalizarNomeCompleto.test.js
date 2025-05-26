const { capitalizarNomeCompleto } = require('../index');
console.log('capitalizarNomeCompleto:', capitalizarNomeCompleto);

describe('Função capitalizarNomeCompleto', () => {

  test('Nome simples todo minúsculo', () => {
    expect(capitalizarNomeCompleto('maria')).toBe('Maria');
  });

  test('Nome simples todo maiúsculo', () => {
    expect(capitalizarNomeCompleto('MARIA')).toBe('Maria');
  });

  test('Nome simples com letras misturadas', () => {
    expect(capitalizarNomeCompleto('MaRiA')).toBe('Maria');
  });

  test('Duas palavras todas minúsculas', () => {
    expect(capitalizarNomeCompleto('joão silva')).toBe('João Silva');
  });

  test('Duas palavras com maiúsculas aleatórias', () => {
    expect(capitalizarNomeCompleto('JOÃO SiLVA')).toBe('João Silva');
  });

  test('Mais de duas palavras', () => {
    expect(capitalizarNomeCompleto('maria da silva')).toBe('Maria Da Silva');
  });

  test('Espaços no início e no fim', () => {
    expect(capitalizarNomeCompleto('  maria silva  ')).toBe('Maria Silva');
  });

  test('Múltiplos espaços entre nomes', () => {
    expect(capitalizarNomeCompleto('maria   da   silva')).toBe('Maria Da Silva');
  });

  test('Nome com hífen', () => {
    expect(capitalizarNomeCompleto('ana-maria')).toBe('Ana-Maria');
  });

  test('Nome com apóstrofo', () => {
    expect(capitalizarNomeCompleto("d'artagnan")).toBe("D'Artagnan");
  });

  test('String vazia', () => {
    expect(capitalizarNomeCompleto('')).toBe('');
  });

  test('Null', () => {
    expect(capitalizarNomeCompleto(null)).toBe('');
  });

  test('Undefined', () => {
    expect(capitalizarNomeCompleto(undefined)).toBe('');
  });

  test('Nome com números', () => {
    expect(capitalizarNomeCompleto('joão 123')).toBe('João 123');
  });

  test('Nome com só espaços', () => {
    expect(capitalizarNomeCompleto('   ')).toBe('');
  });

  test('Nome com tabs e quebras de linha', () => {
    expect(capitalizarNomeCompleto('joão\tsilva\n')).toBe('João Silva');
  });

  test('Nome com letras acentuadas', () => {
    expect(capitalizarNomeCompleto('éLia')).toBe('Élia');
  });

  test('Nome já capitalizado corretamente', () => {
    expect(capitalizarNomeCompleto('João Silva')).toBe('João Silva');
  });
});
