# Migração de segurança do Firebase Realtime Database — AZNY

## Estado deste pacote

Este repositório passa a conter uma **base de regras restritiva**, não uma alteração já aplicada ao Firebase Console. Não publicar estas regras ainda: a versão atual do quadro não implementa a criação/verificação dos registos de autorização abaixo e depende de acessos que estas regras bloqueiam deliberadamente.

## Modelo de autorização

As regras usam Firebase Authentication e um registo de autorização confiável:

`roomAccess/{roomKey}/{uid}`

Exemplo de registo que só um servidor confiável (Firebase Admin SDK / Cloud Functions) pode criar:

```json
{
  "role": "teacher",
  "status": "approved"
}
```

Para um aluno aprovado, o servidor cria:

```json
{
  "role": "student",
  "status": "approved",
  "requestId": "-FirebasePushIdDoPedido"
}
```

Nunca criar estes registos a partir do navegador. A raiz `roomAccess` fica sem permissões de leitura/escrita para clientes.

## O que as regras protegem

- Negam por omissão a leitura e escrita na raiz.
- Negam acesso do cliente a `licenses`; os tokens/licenças não devem ser consultados nem alterados diretamente pelo HTML.
- Exigem identidade autenticada e autorização aprovada para aceder aos dados de uma sala.
- Apenas o professor aprovado pode iniciar/alterar o estado da sessão, presença do professor, aviso de recarregamento, navegador partilhado e evento de piano.
- Professor e alunos aprovados podem colaborar no quadro, folha de cálculo e documento partilhado.
- O aluno só pode criar/alterar o seu próprio pedido de entrada e sinalização WebRTC associada ao `requestId` atribuído pelo servidor.
- Os links curtos são públicos para leitura, mas não podem ser criados/alterados diretamente por clientes.

## Alterações obrigatórias no cliente/servidor antes de ativar

O ficheiro `quadro_virtual_azny_quadro.html` ainda contém estes comportamentos incompatíveis com as regras:

1. `validateTeacherLicenseAccess()` lê e pode atualizar `licenses/{token}` diretamente no navegador. Migrar a validação e atualização de trial para uma Callable/HTTPS Cloud Function com Firebase Admin SDK.
2. `getClassLink()` cria `aznyShortLinks/{code}` com uma transação no navegador. Mover a criação para função confiável.
3. O fluxo atual cria pedidos anónimos e usa `studentUid` fornecido pelo próprio cliente. O servidor deve verificar o pedido e a aprovação do professor, depois criar `roomAccess` para o UID autenticado e vincular o `requestId`.
4. O código usa `studentMesh`; esta estrutura não recebe permissão neste primeiro conjunto de regras. Antes de a reativar, desenhar autorização por par de participantes e validar os IDs contra os membros da sala.
5. Rever os restantes caminhos RTDB usados pelo HTML (incluindo métricas, estado de plano e contadores de trial) e migrá-los para funções confiáveis ou regras específicas. Não conceder acesso genérico a `aznyRooms/{room}` ou a `sessions/{session}`.

## Ordem segura de implantação

1. Implementar e publicar as Cloud Functions que validam licenças, aprovam alunos e criam/removem `roomAccess`.
2. Atualizar o cliente para chamar essas funções e remover a leitura/escrita direta em `licenses` e `aznyShortLinks`.
3. Migrar e testar `studentMesh` e todos os outros caminhos RTDB ainda usados.
4. Testar com contas separadas de professor, aluno aprovado, aluno pendente e utilizador não autenticado, incluindo leitura e escrita negadas.
5. Só então publicar `database.rules.json` no Realtime Database.

**Não substituir as regras de produção antes de concluir estes passos**: a aplicação atual perderá acesso a partes da aula. O objetivo é não trocar uma configuração insegura por uma configuração que exponha dados ou deixe a plataforma indisponível.
