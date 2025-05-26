const { extractFallbackFields } = require('../index');

describe('extractFallbackFields', () => {
    const currentYear = new Date().getFullYear();

    // === Casos completos ===
    test('Extrai nome, data, hora e procedimento completos', () => {
        const message = { text: { message: 'João Silva 12/08 14:30 tratamento de canal' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'João Silva',
            data: `${currentYear}-08-12T00:00:00-03:00`,
            hora: '14:30',
            procedimento: 'tratamento de canal'
        });
    });

    test('Extrai nome com até 4 palavras', () => {
        const message = { text: { message: 'Maria Clara Souza Santos da Silva 01-09 9h limpeza dental' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Maria Clara Souza Santos',
            data: `${currentYear}-09-01T00:00:00-03:00`,
            hora: '09:00',
            procedimento: 'limpeza dental'
        });
    });

    test('Data menor que hoje deve avançar ano', () => {
        const hoje = new Date();
        const mes = (hoje.getMonth() + 1).toString().padStart(2, '0');
        const dia = (hoje.getDate() - 1).toString().padStart(2, '0');
        const ano = hoje.getFullYear() + 1;

        const message = { text: { message: `Carlos ${dia}/${mes} 15h extração` } };
        const result = extractFallbackFields(message);

        expect(result).toEqual({
            nome: 'Carlos',
            data: `${ano}-${mes}-${dia}T00:00:00-03:00`,
            hora: '15:00',
            procedimento: 'extração'
        });
    });

    // === Casos parciais ou vazios ===
    test('Extrai apenas nome quando não tem data, hora e procedimento', () => {
        const message = { text: { message: 'Fernanda Lima' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Fernanda Lima',
            data: '',
            hora: '',
            procedimento: ''
        });
    });

    test('Entrada vazia retorna todos vazios', () => {
        expect(extractFallbackFields({})).toEqual({
            nome: '',
            data: '',
            hora: '',
            procedimento: ''
        });
    });

    test('Entrada null retorna todos vazios', () => {
        expect(extractFallbackFields(null)).toEqual({
            nome: '',
            data: '',
            hora: '',
            procedimento: ''
        });
    });

    // === Variações de formatos ===
    test('Extrai data e hora quando nome é uma palavra só', () => {
        const message = { text: { message: 'Paulo 3-12 8h30 limpeza' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Paulo',
            data: expect.stringMatching(/^20\d{2}-12-03T00:00:00-03:00$/),
            hora: '08:30',
            procedimento: 'limpeza'
        });
    });

    test('Extrai hora mesmo com minutos ausentes', () => {
        const message = { text: { message: 'Ana 25/11 9h consulta' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Ana',
            data: expect.stringMatching(/^20\d{2}-11-25T00:00:00-03:00$/),
            hora: '09:00',
            procedimento: 'consulta'
        });
    });

    test('Extrai até 5 palavras para o procedimento após a hora', () => {
        const message = {
            text: { message: 'Roberta 22/11 11:00 extração dente siso inferior esquerdo com dor' }
        };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Roberta',
            data: expect.stringMatching(/^20\d{2}-11-22T00:00:00-03:00$/),
            hora: '11:00',
            procedimento: 'extração dente siso inferior esquerdo' // 5 palavras
        });
    });

    test('Texto com tabs e múltiplos espaços normaliza', () => {
        const message = { text: { message: '  Ana\tMaria  05/05 10h30   limpeza    dental  ' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Ana Maria',
            data: expect.stringMatching(/^20\d{2}-05-05T00:00:00-03:00$/),
            hora: '10:30',
            procedimento: 'limpeza dental'
        });
    });

    // === Casos adicionais ===
    test('Extrai hora com espaço entre "h" e minutos', () => {
        const message = { text: { message: 'Marcos 10/10 10 h 30 consulta' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'Marcos',
            data: expect.stringMatching(/^20\d{2}-10-10T00:00:00-03:00$/),
            hora: '10:30',
            procedimento: 'consulta'
        });
    });

    test('Nomes com acento e hífen', () => {
        const message = { text: { message: 'José-Alfredo da Silva 15/07 13h limpeza' } };
        expect(extractFallbackFields(message)).toEqual({
            nome: 'José-Alfredo da Silva',
            data: expect.stringMatching(/^20\d{2}-07-15T00:00:00-03:00$/),
            hora: '13:00',
            procedimento: 'limpeza'
        });
    });
});
