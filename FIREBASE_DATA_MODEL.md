# Modelo de dados — Remote Work Board

Projeto Firebase: `remot-board`  
Realtime Database: `https://remote-board-default-rtdb.firebaseio.com`

Este documento define o contrato inicial para a nova base de dados. A regra geral é negar acesso por omissão. Operações administrativas, financeiras e de licenças são feitas pelo Admin SDK nas Cloud Functions, nunca por permissões amplas no navegador.

## Estrutura lógica

| Caminho | Finalidade | Quem pode aceder |
|---|---|---|
| `users/{uid}` | Dados básicos da conta e estado | O próprio utilizador, via função validada |
| `profiles/{uid}` | Perfil público/educacional | Campos públicos controlados; escrita via função |
| `licenses/{token}` | Plano, validade, limites e estado | Apenas Cloud Functions |
| `paymentRequests/{id}` | Pedidos de compra/renovação | Cliente submete e consulta o próprio pedido via funções; aprovação apenas admin |
| `payments/{id}` | Comprovativos e estado financeiro | Apenas funções e administração autorizada |
| `roomAccess/{room}/{uid}` | Papel e autorização por sala | Apenas Cloud Functions |
| `aznyRooms/{room}/board` | Conteúdo colaborativo do quadro | Professor e alunos aprovados na sala |
| `aznyRooms/{room}/sessions/{session}` | Estado da aula e participantes | Professor autorizado; aluno conforme estado/pedido |
| `aznyRooms/{room}/sessions/{session}/joinRequests/{id}` | Pedido de entrada do aluno | Aluno dono do pedido e professor da sala |
| `aznyRooms/{room}/sessions/{session}/peers/{id}` | Sinalização WebRTC | Professor da sala e aluno associado ao pedido |
| `aznyRooms/{room}/sessions/{session}/studentMesh` | Sinalização entre alunos | Apenas participantes aprovados e associados |
| `aznyRooms/{room}/sharedBrowser` | Navegação partilhada | Professor e alunos aprovados |
| `aznyRooms/{room}/pianoEvent` | Eventos do piano | Leitura dos aprovados; escrita do professor |
| `aznyRooms/{room}/spreadsheet` | Folha colaborativa | Professor e alunos aprovados |
| `aznyRooms/{room}/webDocument` | Documento colaborativo | Professor e alunos aprovados |
| `aznyShortLinks/{code}` | Redirecionamento de links curtos | Leitura pública apenas do destino; escrita via função |
| `recordings/{id}` | Metadados das gravações | Participantes autorizados, via função |
| `notifications/{uid}/{id}` | Notificações do utilizador | Próprio utilizador, via função |
| `auditLogs/{id}` | Registo de operações sensíveis | Apenas administração/servidor |

## Papéis e limites

- **Administrador:** papel atribuído fora do cliente, por UID confiável configurado no servidor. Nunca confiar num campo `role: "admin"` enviado pelo navegador.
- **Professor:** recebe `roomAccess/{room}/{uid} = { role: "teacher", status: "approved" }` somente depois da validação da licença por função.
- **Aluno:** recebe `{ role: "student", status: "approved", requestId, sessionId }` somente depois da aprovação do professor por função.
- **Visitante/pedido pendente:** não recebe autorização de leitura/escrita do quadro.

## Regras atuais

`database.rules.json` mantém `.read=false` e `.write=false` na raiz, concede acesso granular às funcionalidades de sala já presentes no código e explicita o bloqueio de dados pessoais, pagamentos, licenças, permissões, gravações e auditoria. Os dados financeiros e de identidade ainda não estão liberados ao cliente.

## Não fazer ainda

- Não publicar regras enquanto os fluxos de pagamentos e administração não estiverem migrados e testados.
- Não permitir escrita direta do cliente em `licenses`, `roomAccess`, `payments`, `paymentRequests`, `admin` ou `auditLogs`.
- Não apagar o projeto antigo nem os dados antigos antes da validação funcional do projeto novo.
- Não colocar chaves privadas de service account no repositório.

## Sequência de ativação

1. Confirmar métodos Authentication (e-mail/senha, Google e anónimo).
2. Implementar funções para submissão/consulta de pedidos de pagamento.
3. Implementar aprovação administrativa com UID(s) confiáveis no ambiente Functions.
4. Confirmar o fluxo de conta, licenças e renovação.
5. Testar as regras com Firebase Emulator Suite (professor, aluno pendente, aprovado, utilizador externo e admin).
6. Só então publicar regras e funções no projeto `remot-board`.
