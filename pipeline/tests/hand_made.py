"""The hand-made collection used by P1-02's and P1-10's done tests, with counts worked out by hand.

20 usable games. With a 20% threshold a position is common when at least 4 games reach it, and the
candidates are 3.Bb5 a6 and 3.Bb5 Nf6 in the Spanish (2 games each), 3.a3 after 1.e4 e5 2.Nf3 Nc6
(3 games, one by transposition) and 2...d5 after 1.f3 e5 2.g4 (2 games).
"""

GAMES = [
    # The Spanish trunk: common to move 3, then 3.Bb5 stays common and 3...a6 / 3...Nf6 leave common play.
    ("A1", "B1", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6"),
    ("A2", "B2", "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6"),
    ("A3", "B3", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4"),
    ("A4", "B4", "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5"),
    # 3.a3 leaves common play in two games, and a third game transposes into the same position.
    ("A5", "B5", "e4 e5 Nf3 Nc6 a3 a6 b3"),
    ("A6", "B6", "e4 e5 Nf3 Nc6 a3 h6"),
    ("A8", "B8", "e4 e5 a3 Nc6 Nf3 Nf6"),
    # 3.Na3 in one game, which also appears as a duplicate below.
    ("A7", "B7", "e4 e5 Nf3 Nc6 Na3 Nf6"),
    # 1.Na3 leaves common play at ply 1, too early; the line's later positions give nothing.
    ("A9", "B9", "Na3 e5 Nf3 Nc6 c3"),
    ("A10", "B10", "Na3 e5 Nf3 Nc6 d4"),
    # 1.f3 e5 2.g4 is common here: 2...Qh4# finishes the game, 2...d5 leaves common play.
    ("A11", "B11", "f3 e5 g4 Qh4#"),
    ("A12", "B12", "f3 e5 g4 Qh4#"),
    ("A13", "B13", "f3 e5 g4 d5 h3 Nc6"),
    ("A14", "B14", "f3 e5 g4 d5 h3 Nf6"),
    # 1.d4 is common; its second moves leave common play at ply 2, too early.
    ("A15", "B15", "d4 d5 c4 e6"),
    ("A16", "B16", "d4 d5 c4 c6"),
    ("A17", "B17", "d4 Nf6 c4 e6"),
    ("A18", "B18", "d4 Nf6 c4 g6"),
    # Knights out and back: the starting position again at ply 4, then 1.e4 e5 three moves late.
    ("A19", "B19", "Nf3 Nf6 Ng1 Ng8 e4 e5"),
    ("A20", "B20", "c4 e5"),
]


def pgn_game(white: str, black: str, moves: str, *, headers: str = "", result: str = "*") -> str:
    numbered = []
    for index, move in enumerate(moves.split()):
        numbered.append(f"{index // 2 + 1}. {move}" if index % 2 == 0 else move)
    return (
        f'[Event "Test"]\n[White "{white}"]\n[Black "{black}"]\n[Date "2026.01.01"]\n{headers}'
        f'[Result "{result}"]\n\n{" ".join(numbered)} {result}\n\n'
    )
