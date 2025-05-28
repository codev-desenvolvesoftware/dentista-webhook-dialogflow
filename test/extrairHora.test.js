const matchHoraTexto = (msg) => {
  const match = msg.match(/\b(\d{1,2})[:h](\d{2})\b/i);
  return match ? `${match[1]}:${match[2]}` : null;
};

describe("Extração de hora válida da mensagem", () => {
  test("deve extrair hora no formato HH:MM", () => {
    expect(matchHoraTexto("Maria 10:30 limpeza")).toBe("10:30");
    expect(matchHoraTexto("Consulta às 9:00")).toBe("9:00");
    expect(matchHoraTexto("Horário 14h15 agendado")).toBe("14:15");
  });

  test("não deve confundir dia do mês com hora", () => {
    expect(matchHoraTexto("29/05 9:00 limpeza")).toBe("9:00");
    expect(matchHoraTexto("29/05 avaliação")).toBe(null);
  });

  test("deve retornar null quando não há hora", () => {
    expect(matchHoraTexto("Maria quer agendar")).toBe(null);
    expect(matchHoraTexto("Consulta 10 horas")).toBe(null);
  });
});