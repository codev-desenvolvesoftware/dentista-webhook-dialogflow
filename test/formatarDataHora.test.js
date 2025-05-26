const { formatarDataHora } = require('../index'); 

describe('Função formatarDataHora', () => {

  describe('Formato de hora', () => {
  test('deve formatar "11h" como "11:00"', () => {
    expect(formatarDataHora("11h", "hora")).toBe("11:00");
  });

  test('deve formatar "12" como "12:00"', () => {
    expect(formatarDataHora("12", "hora")).toBe("12:00");
  });

  test('deve formatar "8h" como "08:00"', () => {
    expect(formatarDataHora("8h", "hora")).toBe("08:00");
  });

  test('deve formatar "9" como "09:00"', () => {
    expect(formatarDataHora("9", "hora")).toBe("09:00");
  });

  test('deve formatar "9:45" como "09:45"', () => {
    expect(formatarDataHora("9:45", "hora")).toBe("09:45");
  });

  test('deve formatar "10:30" como "10:30"', () => {
    expect(formatarDataHora("10:30", "hora")).toBe("10:30");
  });

  test('deve formatar "8h45" como "08:45"', () => {
    expect(formatarDataHora("8h45", "hora")).toBe("08:45");
  });

  test('deve formatar "1130" como "11:30"', () => {
    expect(formatarDataHora("1130", "hora")).toBe("11:30");
  });

  test('deve formatar "  7h15  " com espaços como "07:15"', () => {
    expect(formatarDataHora("  7h15  ", "hora")).toBe("07:15");
  });

  test('deve formatar "23h59" como "23:59"', () => {
    expect(formatarDataHora("23h59", "hora")).toBe("23:59");
  });

  test('deve formatar "00h00" como "00:00"', () => {
    expect(formatarDataHora("00h00", "hora")).toBe("00:00");
  });

  test('deve retornar "Hora inválida" para letras como "manhã"', () => {
    expect(formatarDataHora("manhã", "hora")).toBe("Hora inválida");
  });

  test('deve retornar "Hora inválida" para string aleatória "abc123"', () => {
    expect(formatarDataHora("abc123", "hora")).toBe("Hora inválida");
  });

  test('deve retornar "Hora inválida" para "11hm"', () => {
    expect(formatarDataHora("11hm", "hora")).toBe("Hora inválida");
  });

  test('deve retornar "Hora inválida" para "8:ab"', () => {
    expect(formatarDataHora("8:ab", "hora")).toBe("Hora inválida");
  });

  test('deve retornar "Hora inválida" para número 930 (sem string)', () => {
    expect(formatarDataHora(930, "hora")).toBe("");
  });

  test('deve retornar "" para undefined', () => {
    expect(formatarDataHora(undefined, "hora")).toBe("");
  });

  test('deve retornar "" para null', () => {
    expect(formatarDataHora(null, "hora")).toBe("");
  });

  test('deve retornar "" para string vazia', () => {
    expect(formatarDataHora('', "hora")).toBe("");
  });
});


  describe('Formato de data', () => {
  test('deve formatar "2025-05-30T12:00:00-03:00" como "30/05/2025"', () => {
    expect(formatarDataHora("2025-05-30T12:00:00-03:00", "data")).toBe("30/05/2025");
  });

  test('deve formatar "2025-05-30" como "30/05/2025"', () => {
    expect(formatarDataHora("2025-05-30", "data")).toBe("30/05/2025");
  });

  test('deve formatar "05/10/2024" como "05/10/2024"', () => {
    expect(formatarDataHora("05/10/2024", "data")).toBe("05/10/2024");
  });

  test('deve formatar "10-25-2025" (MM-DD-YYYY) como "25/10/2025"', () => {
    expect(formatarDataHora("10-25-2025", "data")).toBe("25/10/2025");
  });

  test('deve formatar "2024/12/01" como "01/12/2024"', () => {
    expect(formatarDataHora("2024/12/01", "data")).toBe("01/12/2024");
  });

  test('deve formatar "2023-01-01T00:00:00Z" como "01/01/2023"', () => {
    expect(formatarDataHora("2023-01-01T00:00:00Z", "data")).toBe("01/01/2023");
  });

  test('deve formatar data com espaços extras " 2025-05-30 " como "30/05/2025"', () => {
    expect(formatarDataHora(" 2025-05-30 ", "data")).toBe("30/05/2025");
  });

  test('deve retornar "Data inválida" para texto aleatório', () => {
    expect(formatarDataHora("banana", "data")).toBe("Data inválida");
  });

  test('deve retornar "Data inválida" para "32/13/2023"', () => {
    expect(formatarDataHora("32/13/2023", "data")).toBe("Data inválida");
  });

  test('deve retornar "Data inválida" para string vazia', () => {
    expect(formatarDataHora("", "data")).toBe("Data inválida");
  });

  test('deve retornar "" para undefined', () => {
    expect(formatarDataHora(undefined, "data")).toBe("");
  });

  test('deve retornar "" para null', () => {
    expect(formatarDataHora(null, "data")).toBe("");
  });

  test('deve retornar "" para número', () => {
    expect(formatarDataHora(20250530, "data")).toBe("");
  });

  test('deve retornar "" para objeto', () => {
    expect(formatarDataHora({ data: "2025-05-30" }, "data")).toBe("");
  });

  test('deve retornar "Data inválida" para string com data truncada "2025-05"', () => {
    expect(formatarDataHora("2025-05", "data")).toBe("Data inválida");
  });

  test('deve formatar "2025-05-30T00:00:00.000Z" como "30/05/2025"', () => {
    expect(formatarDataHora("2025-05-30T00:00:00.000Z", "data")).toBe("30/05/2025");
  });
});

});
