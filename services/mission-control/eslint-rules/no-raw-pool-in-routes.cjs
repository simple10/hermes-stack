/**
 * ESLint rule: no-raw-pool-in-routes
 *
 * Route handlers must use src/db/repos, not raw database access.
 *
 * Flags:
 *   ctx.pool.{select|insert|update|delete}    — direct pool query in handler
 *   masterClient(...)                          — calling masterClient in handler
 *   c.env.DB / c.env.MASTER_DB                — direct D1 binding access
 *   c.env.POOL_*                               — direct pool binding access
 *
 * Exemption: add `// repo-escape: <reason>` on the same line or the line
 * immediately above the expression to suppress the error.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Route handlers must use src/db/repos, not raw pool/masterClient/env.DB access',
    },
    schema: [],
  },

  create(context) {
    /**
     * Check whether a repo-escape comment covers the given node.
     * Covers both:
     *   - leading comments (line above the node)
     *   - trailing comments on the same line (e.g. `foo(); // repo-escape:`)
     */
    function hasEscapeComment(node) {
      const src = context.getSourceCode();
      // Leading comments (lines above).
      const leading = src.getCommentsBefore(node);
      if (leading.some((c) => /repo-escape:/.test(c.value))) return true;
      // Trailing comments on the same line.
      const trailing = src.getCommentsAfter(node);
      if (trailing.some((c) => /repo-escape:/.test(c.value))) return true;
      // Also check comments on the parent statement (catches `const x = foo(); // repo-escape:`).
      const parent = node.parent;
      if (parent) {
        const parentTrailing = src.getCommentsAfter(parent);
        if (parentTrailing.some((c) => /repo-escape:/.test(c.value))) return true;
        const parentLeading = src.getCommentsBefore(parent);
        if (parentLeading.some((c) => /repo-escape:/.test(c.value))) return true;
      }
      return false;
    }

    function report(node, message) {
      if (!hasEscapeComment(node)) {
        context.report({ node, message });
      }
    }

    return {
      MemberExpression(node) {
        // Match ctx.pool.{select|insert|update|delete}
        if (
          node.object &&
          node.object.type === 'MemberExpression' &&
          node.object.object &&
          node.object.object.type === 'Identifier' &&
          node.object.object.name === 'ctx' &&
          node.object.property &&
          node.object.property.type === 'Identifier' &&
          node.object.property.name === 'pool' &&
          node.property &&
          node.property.type === 'Identifier' &&
          ['select', 'insert', 'update', 'delete'].includes(node.property.name)
        ) {
          report(
            node,
            'Direct ctx.pool.* call in route handler. Use src/db/repos instead, or add `// repo-escape: <reason>` above or on this line.',
          );
        }

        // Match c.env.DB or c.env.MASTER_DB
        if (
          node.object &&
          node.object.type === 'MemberExpression' &&
          node.object.object &&
          node.object.object.type === 'Identifier' &&
          node.object.object.name === 'c' &&
          node.object.property &&
          node.object.property.type === 'Identifier' &&
          node.object.property.name === 'env' &&
          node.property &&
          node.property.type === 'Identifier' &&
          ['DB', 'MASTER_DB'].includes(node.property.name)
        ) {
          report(
            node,
            'Direct c.env.DB / c.env.MASTER_DB access in route handler. Use src/db/repos instead, or add `// repo-escape: <reason>` above or on this line.',
          );
        }

        // Match c.env.POOL_<anything>
        if (
          node.object &&
          node.object.type === 'MemberExpression' &&
          node.object.object &&
          node.object.object.type === 'Identifier' &&
          node.object.object.name === 'c' &&
          node.object.property &&
          node.object.property.type === 'Identifier' &&
          node.object.property.name === 'env' &&
          node.property &&
          node.property.type === 'Identifier' &&
          /^POOL_/.test(node.property.name)
        ) {
          report(
            node,
            'Direct c.env.POOL_* access in route handler. Use src/db/repos instead, or add `// repo-escape: <reason>` above or on this line.',
          );
        }
      },

      CallExpression(node) {
        // Match masterClient(...) calls
        if (
          node.callee &&
          node.callee.type === 'Identifier' &&
          node.callee.name === 'masterClient'
        ) {
          report(
            node,
            'masterClient(...) call in route handler. Use src/db/repos (e.g. db.users(ctx), db.apiKeys(ctx)) instead, or add `// repo-escape: <reason>` above or on this line.',
          );
        }
      },
    };
  },
};
