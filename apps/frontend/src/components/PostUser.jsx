import { useState } from "react";
import { api } from "../lib/api";

const PostUser = () => {
  const [user, setUser] = useState({ name: "", age: "", email: "" });
  const [loading, setLoading] = useState(false);

  const createUser = async () => {
    try {
      setLoading(true);

      // Coerce age to a number if possible (backend often expects a number)
      const payload = {
        ...user,
        age: user.age === "" ? null : Number.isNaN(Number(user.age)) ? user.age : Number(user.age),
      };

      const res = await api.post("/api/form", payload, {
        headers: { "Content-Type": "application/json" },
      });

      setUser({ name: "", age: "", email: "" });
      alert("User Created:\n" + JSON.stringify(res.data, null, 2));
    } catch (err) {
      console.error("Create user failed:", err);
      alert("Failed to create user: " + (err?.message || "unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const onChangeForm = (e) => {
    const { name, value } = e.target;
    setUser((u) => ({ ...u, [name]: value }));
  };

  return (
    <div>
      <div>
        <div>
          <h1>Create User</h1>
          <form onSubmit={(e) => e.preventDefault()}>
            <div>
              <div>
                <label htmlFor="name">Name</label>
                <input
                  type="text"
                  value={user.name}
                  onChange={onChangeForm}
                  name="name"
                  id="name"
                  placeholder="Name"
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="age">Age</label>
                <input
                  type="number"
                  value={user.age}
                  onChange={onChangeForm}
                  name="age"
                  id="age"
                  placeholder="Age"
                  min="0"
                />
              </div>
            </div>
            <div>
              <div>
                <label htmlFor="email">Email</label>
                <input
                  type="email"
                  value={user.email}
                  onChange={onChangeForm}
                  name="email"
                  id="email"
                  placeholder="Email"
                  autoComplete="off"
                />
              </div>
            </div>
            <button type="button" onClick={createUser} disabled={loading}>
              {loading ? "Creating..." : "Create"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default PostUser;
