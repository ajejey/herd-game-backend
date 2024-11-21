import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    unique: true
  }
});

export default mongoose.model('Question', questionSchema);
