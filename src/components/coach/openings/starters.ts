// Starter repertoires: small, sound, and built around a few ideas you can remember.
// Every line was checked move by move with Stockfish (your moves stay close to its best).

export type StarterLine = { name: string; san: string };
export type Starter = {
    id: string;
    side: "white" | "black";
    title: string;
    summary: string;
    lines: StarterLine[];
};

export const STARTERS: Starter[] = [
    {
        id: "london",
        side: "white",
        title: "London System",
        summary: "d4, Bf4, e3, Nf3, c3, Nbd2, Bd3: the same setup against almost everything.",
        lines: [
            {
                name: "Main line: ...d5, ...e6, ...c5",
                san: "d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3",
            },
            {
                name: "...d5 and ...Bf5",
                san: "d4 d5 Bf4 Bf5 e3 e6 Nf3 Nf6 Bd3 Bxd3 Qxd3 c5 c3 Nc6 Nbd2",
            },
            {
                name: "Early ...c5 and ...Qb6",
                san: "d4 d5 Bf4 c5 e3 Nc6 c3 Qb6 Qb3 c4 Qc2 Nf6 Nd2",
            },
            {
                name: "Early ...c5, quiet",
                san: "d4 d5 Bf4 c5 e3 Nc6 c3 Nf6 Nd2 e6 Ngf3 Bd6 Bg3 O-O Bd3",
            },
            {
                name: "...Nf6 and ...e6",
                san: "d4 Nf6 Bf4 e6 e3 c5 c3 Nc6 Nd2 d5 Ngf3 Bd6 Bg3 O-O Bd3",
            },
            {
                name: "King's Indian setup (...g6)",
                san: "d4 Nf6 Bf4 g6 e3 Bg7 Nf3 O-O Be2 d6 h3 Nbd7 O-O",
            },
            {
                name: "Dutch (...f5)",
                san: "d4 f5 Bf4 Nf6 e3 e6 Nf3 Be7 Bd3 O-O Nbd2",
            },
            {
                name: "...e6 move order",
                san: "d4 e6 Bf4 d5 e3 Nf6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3",
            },
        ],
    },
    {
        id: "scandi-qa5",
        side: "black",
        title: "Scandinavian: 3...Qa5",
        summary: "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5, then ...Nf6, ...c6, ...Bf5 and ...e6.",
        lines: [
            {
                name: "Main line: 4.d4",
                san: "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Qe2 Bb4 O-O-O Nbd7",
            },
            {
                name: "4.d4 with 5.Bc4",
                san: "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Bc4 c6 Nf3 Bf5 Bd2 e6",
            },
            {
                name: "4.Nf3",
                san: "e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3 Nf6 d4 c6 Bc4 Bf5",
            },
            {
                name: "4.Bc4",
                san: "e4 d5 exd5 Qxd5 Nc3 Qa5 Bc4 Nf6 d3 c6 Bd2 Qc7",
            },
            {
                name: "3.Nf3",
                san: "e4 d5 exd5 Qxd5 Nf3 Nf6 d4 Bg4 Be2 Nc6 O-O O-O-O",
            },
            {
                name: "3.d4",
                san: "e4 d5 exd5 Qxd5 d4 Nf6 Nf3 Bg4 Be2 Nc6 O-O O-O-O",
            },
            {
                name: "2.e5",
                san: "e4 d5 e5 Bf5 d4 e6 Nf3 c5 c3 Nc6",
            },
            {
                name: "2.Nc3",
                san: "e4 d5 Nc3 d4 Nce2 e5 Ng3 Be6",
            },
        ],
    },
];
