import express from "express";
import { splitController } from "../controllers/split.controller.js";

const router = express.Router();

router.post("/", splitController);

export default router;
