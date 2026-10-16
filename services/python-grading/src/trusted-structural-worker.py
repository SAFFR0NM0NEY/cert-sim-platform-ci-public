#!/usr/bin/env python3
"""Generic trusted AST/token evaluator. It never executes learner source."""

import ast
import io
import json
import re
import sys
import tokenize


def typed(value):
    if type(value) is bool: return {"type": "bool", "value": value}
    if type(value) is int: return {"type": "int", "value": str(value)}
    if type(value) is float: return {"type": "float", "value": value.hex()}
    if type(value) is str: return {"type": "string", "value": value}
    raise ValueError("unsupported literal")


def name(node):
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute):
        prefix = name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def literal(node):
    if isinstance(node, ast.Constant): return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)) and isinstance(node.operand, ast.Constant):
        return -node.operand.value if isinstance(node.op, ast.USub) else node.operand.value
    raise ValueError("unsupported default")


def scoped_anchors(function, anchor_type):
    anchors = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            if node is function:
                for statement in node.body: self.visit(statement)

        def visit_AsyncFunctionDef(self, node):
            if node is function:
                for statement in node.body: self.visit(statement)

        def visit_ClassDef(self, _node): return
        def visit_Lambda(self, _node): return

        def generic_visit(self, node):
            if isinstance(node, anchor_type): anchors.append(node)
            super().generic_visit(node)

    Visitor().visit(function)
    return sorted(anchors, key=lambda node: (node.lineno, node.col_offset))


def covers_concept_groups(words, groups):
    candidates = [[index for index, word in enumerate(words) if word in vocabulary] for vocabulary in groups]
    if any(not positions for positions in candidates): return False
    ordered = sorted(candidates, key=len)

    def assign(group_index, used):
        if group_index == len(ordered): return True
        return any(position not in used and assign(group_index + 1, used | {position}) for position in ordered[group_index])

    return assign(0, set())


def evaluate_token_comment(source, tree, compiled):
    function = next((node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == compiled["target"]), None)
    if function is None: return False
    anchor_type = ast.For if compiled["anchor"] == "For" else ast.Return
    anchors = scoped_anchors(function, anchor_type)
    occurrence = compiled["anchorOccurrence"]
    if len(anchors) < occurrence: return False
    anchor = anchors[occurrence - 1]
    lines = source.splitlines()
    comments = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type != tokenize.COMMENT: continue
            line_number, column = token.start
            if lines[line_number - 1][:column].strip(): continue
            comments.append((line_number, column, token.string[1:]))
    except (tokenize.TokenError, IndentationError):
        return False
    for line_number, column, comment in comments:
        if line_number >= anchor.lineno or column != anchor.col_offset: continue
        if any(lines[index - 1].strip() for index in range(line_number + 1, anchor.lineno)): continue
        words = re.findall(r"[a-z]+", comment.casefold())
        if covers_concept_groups(words, compiled["requiredConceptGroups"]): return True
    return False


def evaluate(source, compiled):
    try: tree = ast.parse(source)
    except SyntaxError: return False
    family = compiled["family"]
    if family == "token_comment":
        return evaluate_token_comment(source, tree, compiled)
    if family == "ast_docstring":
        if compiled["target"] == "module": return ast.get_docstring(tree, clean=False) == compiled["expected"]
        function = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == compiled["target"]), None)
        return function is not None and ast.get_docstring(function, clean=False) == compiled["expected"]
    if family == "ast_signature":
        function = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == compiled["target"]), None)
        if function is None: return False
        try: defaults = [typed(literal(item)) for item in function.args.defaults]
        except (TypeError, ValueError): return False
        return [item.arg for item in function.args.args] == compiled["parameters"] and defaults == compiled["defaults"]
    calls = [name(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)]
    attributes = [name(node) for node in ast.walk(tree) if isinstance(node, ast.Attribute)]
    if any(item in calls for item in compiled["forbiddenCalls"]) or any(item in attributes for item in compiled["forbiddenAttributes"]): return False
    if family == "ast_absence": return True
    names = [node.id for node in ast.walk(tree) if isinstance(node, ast.Name)]
    definitions = [node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    literals = [typed(node.value) for node in ast.walk(tree) if isinstance(node, ast.Constant) and type(node.value) in (str, int, float, bool)]
    operators = [type(node).__name__ for node in ast.walk(tree) if isinstance(node, (ast.operator, ast.boolop, ast.cmpop, ast.unaryop))]
    for required in compiled["requiredNodes"]:
        if sum(isinstance(node, getattr(ast, required["type"], ())) for node in ast.walk(tree)) < required["minimum"]: return False
    call_tails = [item.split(".")[-1] for item in calls]
    if any(item not in calls and item.split(".")[-1] not in call_tails for item in compiled["requiredCalls"]): return False
    if any(item not in names for item in compiled["requiredNames"]): return False
    if any(item not in definitions for item in compiled["requiredDefinitions"]): return False
    if any(item not in attributes for item in compiled["requiredAttributes"]): return False
    if any(item not in literals for item in compiled["requiredLiterals"]): return False
    if any(item not in operators for item in compiled["requiredOperators"]): return False
    if compiled["orderedNames"]:
        positions = []
        for required in compiled["orderedNames"]:
            lines = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == required]
            if not lines: return False
            positions.append(min(lines))
        if positions != sorted(positions): return False
    if compiled["requireDynamicReturn"]:
        returns = [node.value for node in ast.walk(tree) if isinstance(node, ast.Return) and node.value is not None]
        if not returns or all(isinstance(node, ast.Constant) for node in returns): return False
    return True


payload = json.load(sys.stdin)
print(json.dumps([evaluate(payload["source"], rule) for rule in payload["rules"]], separators=(",", ":")))
