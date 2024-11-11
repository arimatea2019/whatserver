const express = require('express');
const http = require('http');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const events = require('events');
const mysql = require('mysql2/promise');
const { Console } = require('console');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dia = '31-10'
const dbConfig = {
    host: '********',
    user: '*******',
    password: '*****',
    database: '********'
};

events.EventEmitter.defaultMaxListeners = 50; // Increase the limit of allowed listeners

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'))); // Use relative path for public directories
const ATTENDANT_MESSAGES_FILE = path.join(__dirname, 'attendantMessages.json');
const TEMPERATURES_FILE = path.join(__dirname, 'temperatures.json');
const CALLBACK_FILE = path.join(__dirname, 'callback.json');


const attendants = [
    "Ari","Aliny Gomes", "Amanda Bispo", "Andresa Santos", "Arlete Silva", 
    "Brunna Neves", "Cintia Maria", "Eduardo Pedrazzi", "Flávia Pereira", 
    "Franciele Vilanova", "Gustavo Teixeira", "Igor Castro", "Igor Santos", 
    "Isabelle Pereira", "Ivanete Costa", "Jaqueline Panza", "Julia Carvalho", 
    "Jéssica Briones", "Laís Nunes", "Lena Santos", "Lucas Albuquerque", 
    "Lucas Eduardo", "Marcia Gonçalves", "Marta Martins", "Mayara Vilela", 
    "Natalia Leite", "Priscila Figueredo", "Rillary Cristine", "Roselaine Torres", 
    "Rosemeire Vieira", "Sara Placido","Aline Torres","Bruna Souto","João Anderson",
    "João Victor","Kemily Martins","Pereira de Freitas","Milena Brito","Gabriel Oliveira",
    "Caio Nicacio","Elisangela Correia","Marília Bastos","Natália Firmino","Lauriston Pereira",
    "Jade Gomes","cintia domingues","Larissa Almeida","Suelen Souza",
];

const clients = new Array(attendants.length);
const clientReady = new Array(attendants.length).fill(false);
const logados = new Array(attendants.length).fill(null);
const buscados = new Array(attendants.length).fill(null);

let stopSending = new Array(attendants.length).fill(false);
let messagesByAttendant;
let temperatures = {};


function loadMessages() {
    if (fs.existsSync(ATTENDANT_MESSAGES_FILE)) {
        const data = fs.readFileSync(ATTENDANT_MESSAGES_FILE);
        messagesByAttendant = JSON.parse(data);
    } else {    
        // Inicialize com mensagens padrão ou vazio
        messagesByAttendant = {};
        saveMessages(); // Salva o estado inicial no arquivo
    }
}

function saveMessages() {
    fs.writeFileSync(ATTENDANT_MESSAGES_FILE, JSON.stringify(messagesByAttendant, null, 2));
}


function loadTemperatures() {
    if (fs.existsSync(TEMPERATURES_FILE)) {
        const data = fs.readFileSync(TEMPERATURES_FILE);
        temperatures = JSON.parse(data);
    } else {
        temperatures = {};
        saveTemperatures();
    }
}

function saveTemperatures() {
    fs.writeFileSync(TEMPERATURES_FILE, JSON.stringify(temperatures, null, 2));
}

function loadCallbacks() {
    if (fs.existsSync(CALLBACK_FILE)) {
        const data = fs.readFileSync(CALLBACK_FILE, 'utf8');
        try {
            return JSON.parse(data) || [];
        } catch (error) {
            console.error('Erro ao analisar o JSON:', error);
            return [];
        }
    } else {
        return [];
    }
}

// Função para salvar os dados no arquivo JSON
function saveCallbacks(callbacks) {
    fs.writeFileSync(CALLBACK_FILE, JSON.stringify(callbacks, null, 2));
}


async function getClientData(clientNumber) {
    const connection = await mysql.createConnection(dbConfig);
    try {
        
        const [rows] = await connection.execute('SELECT NOME,CPF FROM lista WHERE TELEFONE = ?', [clientNumber]);
        return rows[0]; 
    } finally {
        await connection.end();
    }
}

async function sendClientData(clientNumber) {
    const clientData = await getClientData(clientNumber);
    if (!clientData) {
        console.log(`No data found for ${clientNumber}`);
        return;
    }

    // Monta a string com os dados do cliente
    const clientInfo = `Solicitação de retirada Cliente: ${clientData.nome}, CPF: ${clientData.cpf}\n`;

    // Define o caminho para o arquivo Blacklist.txt
    const filePath = path.join(__dirname, 'Blacklist.txt');

    // Salva a informação no arquivo Blacklist.txt
    fs.appendFile(filePath, clientInfo, (err) => {
        if (err) {
            console.error('Failed to write to file:', err);
        } else {
            console.log('Client data saved to Blacklist.txt');
        }
    });
}

function getRandomDelay(temperature) {
    let min, max;
    switch (temperature) {
        case 'verificado':
            min = 30000; 
            max = 60000; 
            break;
        case 'quente':
            min = 120000;
            max = 180000;
            break;
        case 'morno':
            min = 240000;
            max = 300000;
            break;
        case 'frio':
            min = 360000;
            max = 420000;
            break;
    }
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


async function sendMessages(data, index, banco) {
    console.log(`Iniciando envio de mensagens para o atendente ${attendants[index]}.`);
    
    const connection = await mysql.createConnection(dbConfig);
    const attendant = attendants[index];
    const temperature = temperatures[attendant] || 'morno';
    
    // Marcar os registros como em processamento e filtrar pelo banco
    const [rowsToProcess] = await connection.execute(`
        SELECT DISTINCT CPF AS cpf, TELEFONE AS number, MARGEM AS margem, NOME AS name
        FROM lista
        WHERE ATENDENTE = ?
            AND data = ?
            AND (DISPARADO IS NULL OR (DISPARADO <> 'Sim' AND DISPARADO <> 'Sem whatsapp'))
            AND emProcessamento = 0
            AND BANCO = ?
    `, [attendant, data, banco]); // Adicionando a filtragem pelo banco

    // Total de mensagens e contagem de mensagens processadas
    const totalMessages = rowsToProcess.length;
    let messagesProcessed = 0;

    const dddsComNove = ['11', '12', '13', '14', '15', '16', '17', '18', '19'];

    function dddPrecisaDeNove(number) {
        const ddd = number.slice(0, 2);
        return dddsComNove.includes(ddd);
    }
    for (const row of rowsToProcess) {

        const currentHour = new Date().getHours();
        const startHour = 7; // 08h
        const endHour = 19;  // 19h

        if (currentHour < startHour || currentHour >= endHour) {
            console.log(`Envio de mensagens fora do horário permitido para o atendente ${attendants[index]}. Parando o envio.`);
            stopSending[index] = true;
            break;
        }

        if (stopSending[index]) {
            console.log(`Message sending stopped by user request for client index: ${index}`);
            break;
        }

        let { number, name, cpf, margem } = row;
        let numero = number;

        await connection.execute(`UPDATE lista SET emProcessamento = 1 WHERE CPF = ? AND TELEFONE = ?`, [cpf, number]);

        if (number === null) {
            await connection.execute('UPDATE lista SET DISPARADO = "Sem whatsapp" WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);
            await connection.execute('UPDATE lista SET invalidNumber = 1 WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);
            console.log(`Number ${numero} is not a valid WhatsApp user`);
            messagesProcessed++;
            continue;
        }

        number = number.toString();
        
        if (number.length >= 11 && number[2] === '9' && !dddPrecisaDeNove(number)) {
            number = number.slice(0, 2) + number.slice(3);
        }

        const cleanedNumber = `55${number.replace(/\D/g, '')}@c.us`;

        try {

            const [rows] = await connection.execute('SELECT * FROM lista WHERE TELEFONE = ? AND CPF = ? AND DISPARADO IS NOT NULL AND ATENDENTE = ?', [numero, cpf, attendant]);
            
            if (rows.length > 0) {
                console.log(`Number ${cleanedNumber} already processed.`);
                messagesProcessed++;
                continue;
            }

            if (!(await clients[index].isRegisteredUser(cleanedNumber))) {
                await connection.execute('UPDATE lista SET DISPARADO = "Sem whatsapp" WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);
                await connection.execute('UPDATE lista SET invalidNumber = 1 WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);
                console.log(`Number ${cleanedNumber} is not a valid WhatsApp user`);
                messagesProcessed++;
                continue;
            }




            const attendantName = attendants[index];
            let message = messagesByAttendant[attendantName];
            if (message.includes('<name>')) {
                message = message.replace(/<name>/g, name);
                if (message.includes('<margem>')) {
                    message = message.replace(/<margem>/g, `R$ ${margem}`);
                }
            }



            await clients[index].sendMessage(cleanedNumber, message);
            messagesProcessed++;
            console.log(`Mensagem enviada do Client: ${attendants[index]}, para o cliente: ${name}, numero: ${cleanedNumber}`);
            await connection.execute('UPDATE lista SET DISPARADO = "Sim" WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);
            await connection.execute('UPDATE lista SET whatsappSent = 1 WHERE TELEFONE = ? AND CPF = ?', [numero, cpf]);

            io.emit('message-sent', { clientIndex: index, sent: messagesProcessed, total: totalMessages });
        } catch (error) {
            console.error(`Error sending message to ${cleanedNumber}`, error);
        }

        const delayMs = getRandomDelay(temperature);
        io.emit('next-message-timer', { clientIndex: index, intervalo: delayMs });
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    await connection.end();
}

const initWhatsAppClient = async (index) => {
    if (clients[index]) {
        console.log(`Client ${index} is already initialized.`);
        return;
    }
    try {
        console.log(`Iniciando client index: ${index}`);
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `client-${index}`,
                dataPath: path.join(__dirname, '.sessions')
            }),
            puppeteer: {
                timeout: 60000,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-web-security",
                    "--disable-features=IsolateOrigins,site-per-process",
                    "--ignore-certificate-errors",
                ],
                headless: true,
            }
        });

        delete client.authStrategy.logout;
        client.authStrategy.logout = async () => {};

        const handleClientEvents = client => {
            client.on('ready', async () => {
                console.log(`Client ${index} (${attendants[index]}) is ready!`);
                clientReady[index] = true;
                stopSending[index] = false;
                clients[index] = client;
                clearTimeout(timeoutHandle); // Limpa o timeout quando o cliente fica pronto
                io.emit('client-ready', { clientIndex: index, ready: true, attendant: attendants[index] });
            });

            client.on('qr', (qr) => {
                console.log(`QR RECEIVED FOR SESSION ${index}`);
                io.emit('qr', { clientIndex: index, qr, attendant: attendants[index] });
                io.emit('client-ready', { clientIndex: index, ready: false, attendant: attendants[index] });
            });

            client.on('auth_failure', (message) => {
                console.error(`Client ${index} authentication failed`, message);
            });

            client.on('disconnected', async (reason) => {
                console.log(`Client ${index} was logged out`, reason);
                clientReady[index] = false;
                stopSending[index] = true;
                io.emit('client-ready', { clientIndex: index, ready: false, attendant: attendants[index] });
            });

            client.on('change_state', async (state) => {
                console.log(`Client ${index} changed state to ${state}`);
            });

            client.on('message', async msg => {
                if (msg.from.endsWith('@c.us')) {
                    console.log(`Client received a message: ${msg.body.trim()}`);
                    const userResponse = msg.body.trim();
                    const formattedNumber = msg.from.replace('@c.us', '').replace('55', '');

                    const connection = await mysql.createConnection(dbConfig);
                    try {
                        const [rows] = await connection.execute('SELECT * FROM lista WHERE TELEFONE = ?', [formattedNumber]);

                        if (rows.length > 0) {
                            const row = rows[0];

                            if (!row.responded) {
                                await connection.execute('UPDATE lista SET responded = TRUE WHERE TELEFONE = ?', [formattedNumber]);
                                console.log(`Marked ${msg.from} as responded.`);
                            }

                            if (userResponse === '2') {
                                console.log(`Received stop request from ${msg.from}`);
                                await sendClientData(formattedNumber);
                                const stopMessage = `Ah, tudo bem! De qualquer forma agradeço a atenção e encerro meu atendimento por agora. Caso mude de ideia ou queira consultar outro dia, fico à total disposição para te auxiliar! Lembrando que nada é feito sem sua confirmação pelo seu próprio aplicativo do Banco do Brasil. Tenha um ótimo dia!`;
                                await client.sendMessage(msg.from, stopMessage);
                            }
                        } else {
                            console.log(`Number ${msg.from} not found in the database. Ignoring message.`);
                        }
                    } catch (error) {
                        console.error('Error querying the database: ', error);
                    } finally {
                        await connection.end();
                    }
                }
            });

        };

        handleClientEvents(client);

        const timeoutHandle = setTimeout(() => {
            if (!clientReady[index]) {
                console.log(`Client ${index} did not become ready within 2 minutes. Destroying the client.`);
                client.destroy(); // Destroi o cliente se o QR code não for lido em 2 minutos
                clients[index] = null; // Reseta o cliente
                io.emit('client-ready', { clientIndex: index, ready: false, attendant: attendants[index] });
            }
        }, 120000); // 120000 ms = 2 minutos

        await client.initialize();
    } catch (error) {
        console.error(`Failed to initialize client ${index} due to an error:`, error);
        const sessionPath = path.join(__dirname, '.sessions', `session-client-${index}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        await initWhatsAppClient(index);
    }
};

// Endpoint para iniciar o cliente WhatsApp pelo índice
app.post('/start-client/:index', async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index >= attendants.length) {
        return res.status(400).json({ error: 'Invalid client index' });
    }

    try {
        if (clients[index]) {
            await clients[index].destroy();
            clients[index] = null;
        }
        await initWhatsAppClient(index);
        res.status(200).json({ success: true, message: `Client ${index} initialization started` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to initialize client' });
    }
});

app.post('/disconnect-whatsapp', async (req, res) => {
    const { clientIndex } = req.body;

    if (clientIndex === undefined || clientIndex < 0 || clientIndex >= clients.length) {
        return res.status(400).json({ success: false, message: 'Invalid client index provided' });
    }

    try {
        if (clients[clientIndex]) {
            await clients[clientIndex].destroy(); // Desconecta o cliente
            clients[clientIndex] = null; // Remove a referência ao cliente
            const sessionPath = path.join(__dirname, '.sessions', `session-client-${clientIndex}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            // Recria o cliente chamando a função initWhatsAppClient
            await initWhatsAppClient(clientIndex);

            res.status(200).json({ success: true, message: `Client ${clientIndex} disconnected and reinitialized` });
        } else {
            res.status(404).json({ success: false, message: `Client ${clientIndex} not found` });
        }
    } catch (error) {
        console.error(`Failed to disconnect and reinitialize WhatsApp client ${clientIndex}:`, error);
        res.status(500).json({ success: false, message: 'Failed to disconnect and reinitialize WhatsApp client', error: error.toString() });
    }
});

// Rota para buscar dados do cliente pelo nome
app.get('/search', async (req, res) => {
    const { name } = req.query; // Recebe o nome do cliente da query string
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nome do cliente é necessário para a busca' });
    }

    // Formatação do termo diretamente na rota
    let termoCelular = name.replace(/[\(\)-]|\s/g, ''); // Remove parênteses, traços e espaços
    termoCelular = termoCelular.replace(/^\+55/, ''); // Remove o código de país +55 se estiver no início
    let termoCpf = name.replace(/[\.\-]/g, ''); // Remove pontos e traços
    if (termoCpf.length < 11) {
        termoCpf = termoCpf.padStart(11, '0'); // Completa com zeros à esquerda até ter 11 dígitos
    }

    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT * FROM lista WHERE NOME LIKE ? OR TELEFONE = ? OR CPF = ?'; // Consulta SQL atualizada
        const [rows] = await connection.execute(query, [`%${name}%`, termoCelular, termoCpf]); // Passa os termos como parâmetros para evitar injeção de SQL
        await connection.end();

        if (rows.length === 0) {
            res.status(404).json({ success: false, message: 'Cliente não encontrado' });
        } else {
            res.json({ success: true, data: rows });
        }
    } catch (error) {
        console.error('Erro na busca dos dados do cliente:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.post('/set-temperature', (req, res) => {
    const { clientIndex, temperature } = req.body;

    const validTemperatures = ['quente', 'morno', 'frio', 'verificado'];
    if (clientIndex === undefined || clientIndex < 0 || clientIndex >= attendants.length) {
        return res.status(400).json({ success: false, message: 'Invalid client index provided' });
    }

    if (!validTemperatures.includes(temperature)) {
        return res.status(400).json({ success: false, message: 'Invalid temperature provided' });
    }

    const attendantName = attendants[clientIndex];
    temperatures[attendantName] = temperature;
    saveTemperatures();

    res.status(200).json({ success: true, message: 'Temperature updated successfully' });
});

app.get('/client-state', async (req, res) => {
    const { clientIndex } = req.query;

    if (clientIndex === undefined || clientIndex < 0 || clientIndex >= clients.length) {
        return res.status(400).json({ success: false, message: 'Invalid client index provided' });
    }

    const attendant = attendants[clientIndex];

    try {
        const connection = await mysql.createConnection(dbConfig);

        const [resultsDisparadas] = await connection.execute(
            `SELECT COUNT(*) as disparadas FROM lista WHERE (DISPARADO = 'Sim' OR DISPARADO = 'Sem WhatsApp') AND data = ? AND ATENDENTE = ?`,
            [dia, attendant]
        );

        const disparadas = resultsDisparadas[0].disparadas;

        const [resultsTotais] = await connection.execute(
            `SELECT COUNT(*) as totais FROM lista WHERE data = ? AND ATENDENTE = ?`,
            [dia, attendant]
        );

        const totais = resultsTotais[0].totais;
        const restantes = totais - disparadas;

        await connection.end();

        res.status(200).json({
            success: true,
            ready: clientReady[clientIndex],
            attendant: attendant,
            disparadas: disparadas,
            totais: totais,
            restantes: restantes
        });
    } catch (error) {
        console.error('Erro ao consultar o banco de dados', error);
        res.status(500).json({ success: false, message: 'Erro ao consultar o banco de dados' });
    }
});

app.post('/login', async (req, res) => {
    const { login, senha } = req.body;

    if (!login || !senha) {
        return res.status(400).json({ success: false, message: 'Login e senha são necessários' });
    }

    try {
        const connection = await mysql.createPool(dbConfig);
        const query = 'SELECT login, senha, cargo FROM Usuarios WHERE BINARY login = ?';
        console.log(`Tentando login com: ${login}`);
        const [rows] = await connection.execute(query, [login]);
        console.log('Resultado da consulta:', rows);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Login ou senha incorretos' });
        }

        const user = rows[0];
        const senhaCorreta = await bcrypt.compare(senha, user.senha);

        if (!senhaCorreta) {
            return res.status(401).json({ success: false, message: 'Login ou senha incorretos' });
        }

        // Verifica se o nome do usuário existe no array de atendentes
        const attendantIndex = attendants.findIndex(attendant => attendant.startsWith(user.login));
        const attendantName = attendantIndex !== -1 ? attendants[attendantIndex] : null;

        if (attendantIndex !== -1) {
            logados[attendantIndex] = attendantName;  // Armazena o nome do atendente no array `logados`
        }

        res.json({
            success: true,
            message: 'Login bem sucedido',
            attendantIndex,
            attendantName,
            cargo: user.cargo
        });

    } catch (error) {
        console.error('Erro ao acessar o banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.post('/change-password', async (req, res) => {
    const { login, currentPassword, newPassword, confirmPassword } = req.body;

    if (!login || !currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'A nova senha e a confirmação da nova senha não correspondem' });
    }

    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT senha FROM Usuarios WHERE BINARY login = ?', [login]);

        if (rows.length === 0) {
            await connection.end();
            return res.status(401).json({ success: false, message: 'Usuário não encontrado' });
        }

        const user = rows[0];
        const senhaCorreta = await bcrypt.compare(currentPassword, user.senha);

        if (!senhaCorreta) {
            await connection.end();
            return res.status(401).json({ success: false, message: 'Senha atual incorreta' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await connection.execute('UPDATE Usuarios SET senha = ? WHERE BINARY login = ?', [hashedPassword, login]);
        await connection.end();

        res.status(200).json({ success: true, message: 'Senha alterada com sucesso' });
    } catch (error) {
        console.error('Erro ao acessar o banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});


app.post('/set-attendant-message', (req, res) => {
    const { attendantIndex, message } = req.body;

    if (attendantIndex === undefined || attendantIndex < 0 || attendantIndex >= attendants.length) {
        return res.status(400).json({ success: false, message: 'Índice do atendente inválido' });
    }

    if (!message) {
        return res.status(400).json({ success: false, message: 'Mensagem é necessária' });
    }

    const attendantName = attendants[attendantIndex];
    messagesByAttendant[attendantName] = message;
    saveMessages(); // Salva as mudanças no arquivo

    res.status(200).json({ success: true, message: 'Mensagem do atendente atualizada com sucesso' });
});

app.get('/individuais', async (req, res) => {
    const { data, atendente } = req.query; // Recebendo a data e o nome do atendente da query string

    if (!data || !atendente) {
        return res.status(400).json({ success: false, message: 'Data e nome do atendente são necessários' });
    }

    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            SELECT data, NOME, UF, CPF, AG, CC, TELEFONE, 
                   DISPARADO, invalidNumber, acceptedSimulation, noInterest, creditStatus
            FROM lista
            WHERE data = ? AND atendente = ?
        `;
        const [rows] = await connection.execute(query, [data, atendente]);
        await connection.end();

        if (rows.length === 0) {
            res.status(404).json({ success: false, message: 'Nenhum dado encontrado para os critérios fornecidos' });
        } else {
            // Armazena o nome do atendente no array `buscados` apenas se houver resultados
            const attendantIndex = attendants.findIndex(attendant => attendant.startsWith(atendente));
            if (attendantIndex !== -1) {
                buscados[attendantIndex] = attendants[attendantIndex];
            }

            res.json({ success: true, data: rows });
        }
    } catch (error) {
        console.error('Erro na consulta ao banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.post('/update_manual', async (req, res) => {
    const { CPF, TELEFONE, attendantName, creditCell, serviceCell, simulationCell } = req.body;

    if (!CPF || !TELEFONE || !attendantName) {
        return res.status(400).json({ success: false, message: 'CPF, TELEFONE, e nome do atendente são necessários' });
    }

    try {
        const connection = await mysql.createConnection(dbConfig);

        const updates = [];
        const values = [];

        // Atualização do campo de Linha de Crédito
        if (creditCell !== undefined) {
            updates.push("creditStatus = ?");
            values.push(creditCell);
        }

        // Atualização do campo de Atendimento (WhatsApp enviado e Número inválido separados)
        if (serviceCell === 'WhatsApp enviado') {
            updates.push("whatsappSent = 1, invalidNumber = NULL, DISPARADO = 'Sim'");
        } else if (serviceCell === 'Número inválido') {
            updates.push("whatsappSent = NULL, invalidNumber = 1, DISPARADO = 'Sem whatsapp'");
        } else if (serviceCell === null) {
            // Aqui, atualizamos apenas o campo correspondente, sem alterar o outro
            if (req.body.whatsappSent !== undefined) {
                updates.push("whatsappSent = NULL, DISPARADO = NULL");
            }
            if (req.body.invalidNumber !== undefined) {
                updates.push("invalidNumber = NULL, DISPARADO = NULL");
            }
        }

        // Atualização do campo de Simulação
        if (simulationCell !== undefined) {
            updates.push(`
                acceptedSimulation = CASE WHEN ? = 'Aceitou simulação' THEN 1 ELSE NULL END,
                noInterest = CASE WHEN ? = 'Não tem interesse' THEN 1 ELSE NULL END
            `);
            values.push(simulationCell, simulationCell);
        }

        if (updates.length === 0) {
            await connection.end();
            return res.status(400).json({ success: false, message: 'Nenhuma atualização fornecida' });
        }

        const query = `
            UPDATE lista
            SET ${updates.join(", ")}
            WHERE CPF = ? AND TELEFONE = ? AND ATENDENTE = ?;
        `;
        values.push(CPF, TELEFONE, attendantName);

        const [result] = await connection.execute(query, values);

        await connection.end();

        res.json({ success: true, message: 'Registro atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar o banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.get('/detail-report', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            WITH filtered_data AS (
                SELECT 
                    ATENDENTE,
                    DISPARADO,
                    responded
                FROM 
                    lista
                WHERE
                    data = ?
            )
            SELECT 
                ATENDENTE AS OPERADOR,
                COUNT(*) AS CLIENTES,
                SUM(CASE WHEN DISPARADO IN ('Sim','Sem whatsapp') THEN 1 ELSE 0 END) AS DISPARADO,
                SUM(CASE WHEN DISPARADO IN ('Sim') THEN 1 ELSE 0 END) AS COM_WHATSAPP,
                SUM(CASE WHEN DISPARADO = 'Sem whatsapp' THEN 1 ELSE 0 END) AS SEM_WHATSAPP,
                SUM(CASE WHEN responded = 1 THEN 1 ELSE 0 END) AS RESPOSTAS,
                IFNULL(ROUND((SUM(CASE WHEN responded = 1 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN DISPARADO = 'Sim' THEN 1 ELSE 0 END), 0)) * 100, 2), 0) AS APROVEITAMENTO
            FROM 
                filtered_data
            GROUP BY 
                ATENDENTE
            UNION ALL
            SELECT 
                'Total' AS OPERADOR,
                COUNT(*) AS CLIENTES,
                SUM(CASE WHEN DISPARADO IN ('Sim','Sem whatsapp') THEN 1 ELSE 0 END) AS DISPARADO,
                SUM(CASE WHEN DISPARADO IN ('Sim') THEN 1 ELSE 0 END) AS COM_WHATSAPP,
                SUM(CASE WHEN DISPARADO = 'Sem whatsapp' THEN 1 ELSE 0 END) AS SEM_WHATSAPP,
                SUM(CASE WHEN responded = 1 THEN 1 ELSE 0 END) AS RESPOSTAS,
                IFNULL(ROUND((SUM(CASE WHEN responded = 1 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN DISPARADO = 'Sim' THEN 1 ELSE 0 END), 0)) * 100, 2), 0) AS APROVEITAMENTO
            FROM 
                filtered_data
            ORDER BY OPERADOR ASC;
        `;

        const [rows] = await connection.execute(query, [dia]);
        await connection.end();
        res.json(rows);
    } catch (error) {
        console.error('Erro ao gerar relatório detalhado:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.get('/menu_datas', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            SELECT data 
            FROM lista 
            GROUP BY data 
            ORDER BY data ASC;

        `;
        const [rows] = await connection.execute(query);
        await connection.end();

        // Assumindo que as datas já estão no formato correto
        const formattedDates = rows.map(row => row.data);

        res.json({ success: true, dates: formattedDates });
    } catch (error) {
        console.error('Erro na consulta ao banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao acessar o banco de dados', error: error.message });
    }
});

app.get('/attendants-status', (req, res) => {
    const connectedAttendants = [];
    const disconnectedAttendants = [];
    const loggedAttendants = [];
    const searchAttendants = [];

    clientReady.forEach((isReady, index) => {
        const attendantName = attendants[index];
        if (isReady) {
            connectedAttendants.push(attendantName);
        } else {
            disconnectedAttendants.push(attendantName);
        }
    });

    logados.forEach((attendantName, index) => {
        if (attendantName) {
            loggedAttendants.push(attendantName);
        }
    });

    buscados.forEach((attendantName, index) => {
        if (attendantName) {
            searchAttendants.push(attendantName);
        }
    });

    res.status(200).json({
        success: true,
        connectedAttendants,
        disconnectedAttendants,
        loggedAttendants,
        searchAttendants
    });
});


// Endpoint para iniciar o disparo de mensagens
app.post('/disparar', async (req, res) => {
    const { clientIndex, banco } = req.body;

    if (clientIndex === undefined || clientIndex < 0 || clientIndex >= attendants.length) {
        return res.status(400).json({ success: false, message: 'Índice do cliente inválido' });
    }

    try {
        stopSending[clientIndex] = false; // Garantir que o disparo esteja habilitado
        await sendMessages(dia, clientIndex, banco); // Chamar a função para disparar mensagens com o banco especificado
        res.status(200).json({ success: true, message: 'Disparo iniciado com sucesso' });
    } catch (error) {
        console.error(`Erro ao iniciar disparo para o clientIndex ${clientIndex}:`, error);
        res.status(500).json({ success: false, message: 'Erro ao iniciar o disparo' });
    }
});

// Endpoint para pausar o disparo de mensagens
app.post('/pausar', (req, res) => {
    const { clientIndex } = req.body;

    if (clientIndex === undefined || clientIndex < 0 || clientIndex >= attendants.length) {
        return res.status(400).json({ success: false, message: 'Índice do cliente inválido' });
    }

    stopSending[clientIndex] = true; // Pausar o disparo de mensagens para o cliente específico
    res.status(200).json({ success: true, message: 'Disparo pausado com sucesso' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    loadMessages();
    loadTemperatures();
    loadCallbacks();
    console.log(`menssagens carregadas`);
});