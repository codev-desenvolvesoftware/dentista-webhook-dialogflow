const { formatarDataHora } = require('../index'); 

describe('Função formatarDataHora', () => {

  describe('Formato de hora', () => {
    test('deve formatar "11h" como "11:00"', () => {
      expect(formatarDataHora("11h", "hora")).toBe("11:00");
    });

    test('deve formatar "9" como "09:00"', () => {
      expect(formatarDataHora("9", "hora")).toBe("09:00");
    });

    test('deve formatar "10:30" como "10:30"', () => {
      expect(formatarDataHora("10:30", "hora")).toBe("10:30");
    });

    test('deve formatar "8h45" como "08:45"', () => {
      expect(formatarDataHora("8h45", "hora")).toBe("08:45");
    });

    test('deve retornar "Hora inválida" para "manhã"', () => {
      expect(formatarDataHora("manhã", "hora")).toBe("Hora inválida");
    });

    test('deve retornar "Hora inválida" para undefined', () => {
      expect(formatarDataHora(undefined, "hora")).toBe("");
    });
  });

  describe('Formato de data', () => {
    test('deve formatar "2025-05-30T12:00:00-03:00" como "30/05/2025"', () => {
      expect(formatarDataHora("2025-05-30T12:00:00-03:00", "data")).toBe("30/05/2025");
    });

    test('deve retornar "Data inválida" para "banana"', () => {
      expect(formatarDataHora("banana", "data")).toBe("Data inválida");
    });

    test('deve retornar "" para undefined', () => {
      expect(formatarDataHora(undefined, "data")).toBe("");
    });
  });
});
